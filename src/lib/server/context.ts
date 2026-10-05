import { type ApiTokenUsage, embeddingModel, estimateTokens, getOpenAIClient, type OpenAIBudget } from "@/lib/server/ai";
import { ensureDatabaseSchema } from "@/lib/server/database";
import { createHash } from "node:crypto";
import { getRawRepositoryFile, getRepositoryTree } from "@/lib/server/github";

const supportedSource = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|php|py|rb|rs|sql|svelte|ts|tsx|vue)$/i;
const ignoredPath = /(?:^|\/)(?:node_modules|vendor|dist|build|\.next|coverage|\.git|\.venv)(?:\/|$)|(?:\.min\.|\.lock\.)/i;
const maxFiles = Number(process.env.MAX_INDEX_FILES ?? 40);
if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
  throw new Error("MAX_INDEX_FILES must be a positive integer.");
}
const maxFileBytes = 80_000;
const linesPerChunk = 80;
const lineOverlap = 10;

type Chunk = { path: string; index: number; content: string };

function splitIntoChunks(path: string, source: string): Chunk[] {
  const lines = source.split(/\r?\n/);
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += linesPerChunk - lineOverlap) {
    const content = lines.slice(start, start + linesPerChunk).join("\n").trim();
    if (content) chunks.push({ path, index: chunks.length, content });
  }
  return chunks;
}

export async function indexRepository(owner: string, repository: string, ref?: string, budget?: OpenAIBudget) {
  const [tree, pool] = await Promise.all([
    getRepositoryTree(owner, repository, ref),
    ensureDatabaseSchema(),
  ]);
  const files = tree.entries
    .filter((entry) => entry.type === "blob" && (entry.size ?? 0) <= maxFileBytes)
    .filter((entry) => supportedSource.test(entry.path) && !ignoredPath.test(entry.path))
    .slice(0, maxFiles);
  if (files.length === 0) throw new Error("No supported source files were found on this branch.");

  const chunks: Chunk[] = [];
  for (let offset = 0; offset < files.length; offset += 5) {
    const batch = files.slice(offset, offset + 5);
    const sources = await Promise.all(
      batch.map(async (file) => ({ path: file.path, source: await getRawRepositoryFile(owner, repository, tree.commitSha, file.path) })),
    );
    for (const source of sources) chunks.push(...splitIntoChunks(source.path, source.source));
  }
  if (chunks.length === 0) throw new Error("No readable source files were found on this branch.");

  // Identical chunk text embeds identically, so earlier embeddings are reused by content hash instead of re-requested.
  const inputs = chunks.map((chunk) => `${chunk.path}\n${chunk.content}`);
  const keys = inputs.map((input) => createHash("sha256").update(input).digest("hex"));
  const cached = await pool.query<{ content_sha256: string; embedding: string }>(
    "SELECT content_sha256, embedding::text AS embedding FROM embedding_cache WHERE model = $1 AND content_sha256 = ANY($2)",
    [embeddingModel, keys],
  );
  const cachedEmbeddings = new Map(cached.rows.map((row) => [row.content_sha256, JSON.parse(row.embedding) as number[]]));
  const missing: number[] = [];
  const pending = new Set<string>();
  keys.forEach((key, index) => {
    if (!cachedEmbeddings.has(key) && !pending.has(key)) {
      pending.add(key);
      missing.push(index);
    }
  });
  const embeddingUsage: ApiTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const embeddingBatches = Math.ceil(missing.length / 64);
  const openai = getOpenAIClient({ maxRetries: budget ? 0 : undefined });
  if (embeddingBatches > 0) {
    const estimatedEmbeddingTokens = missing.reduce((total, index) => total + estimateTokens(inputs[index]), 0);
    await budget?.beforeBatch("index_embeddings", embeddingBatches, estimatedEmbeddingTokens);
  }
  for (let offset = 0; offset < missing.length; offset += 64) {
    const batch = missing.slice(offset, offset + 64);
    const response = await openai.embeddings.create({
      model: embeddingModel,
      input: batch.map((index) => inputs[index]),
      dimensions: 1536,
    });
    const usage = {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: 0,
      totalTokens: response.usage.total_tokens,
    };
    embeddingUsage.inputTokens += usage.inputTokens;
    embeddingUsage.totalTokens += usage.totalTokens;
    await budget?.recordUsage("index_embeddings", usage);
    const ordered = response.data.sort((left, right) => left.index - right.index);
    for (const [position, item] of ordered.entries()) {
      const key = keys[batch[position]];
      cachedEmbeddings.set(key, item.embedding);
      await pool.query(
        "INSERT INTO embedding_cache (model, content_sha256, embedding) VALUES ($1, $2, $3::vector) ON CONFLICT DO NOTHING",
        [embeddingModel, key, `[${item.embedding.join(",")}]`],
      );
    }
  }
  const embeddings = keys.map((key) => cachedEmbeddings.get(key) as number[]);

  const repositoryKey = `${owner}/${repository}`.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize re-indexes of one repository: without the lock, two overlapping READ COMMITTED transactions can each
    // miss the other's inserts in their DELETE and leave chunks from two commits behind.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`repository_chunks:${repositoryKey}`]);
    await client.query("DELETE FROM repository_chunks WHERE repository = $1", [repositoryKey]);
    for (let offset = 0; offset < chunks.length; offset += 32) {
      const batch = chunks.slice(offset, offset + 32);
      const values: unknown[] = [];
      const rows = batch.map((chunk, index) => {
        const valueOffset = index * 6;
        values.push(repositoryKey, tree.commitSha, chunk.path, chunk.index, chunk.content, `[${embeddings[offset + index].join(",")}]`);
        return `($${valueOffset + 1}, $${valueOffset + 2}, $${valueOffset + 3}, $${valueOffset + 4}, $${valueOffset + 5}, $${valueOffset + 6}::vector)`;
      });
      await client.query(
        `INSERT INTO repository_chunks (repository, commit_sha, file_path, chunk_index, content, embedding) VALUES ${rows.join(",")}`,
        values,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { repository: repositoryKey, commitSha: tree.commitSha, branch: tree.branch, maxFiles, filesIndexed: files.length, chunksIndexed: chunks.length, chunksEmbedded: missing.length, embeddingUsage };
}

export async function retrieveRepositoryContextDetailed(repository: string, diff: string, budget?: OpenAIBudget, limit = 8, commitSha?: string) {
  const query = diff.slice(0, 12_000);
  const pool = await ensureDatabaseSchema();
  const queryKey = createHash("sha256").update(query).digest("hex");
  const cached = await pool.query<{ embedding: string }>(
    "SELECT embedding::text AS embedding FROM embedding_cache WHERE model = $1 AND content_sha256 = $2",
    [embeddingModel, queryKey],
  );
  let embeddingUsage: ApiTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let values: number[];
  if (cached.rows[0]) {
    values = JSON.parse(cached.rows[0].embedding) as number[];
  } else {
    const openai = getOpenAIClient({ maxRetries: budget ? 0 : undefined });
    await budget?.beforeBatch("context_embedding", 1, estimateTokens(query));
    const embedding = await openai.embeddings.create({ model: embeddingModel, input: query, dimensions: 1536 });
    embeddingUsage = {
      inputTokens: embedding.usage.prompt_tokens,
      outputTokens: 0,
      totalTokens: embedding.usage.total_tokens,
    };
    await budget?.recordUsage("context_embedding", embeddingUsage);
    values = embedding.data[0].embedding;
    await pool.query(
      "INSERT INTO embedding_cache (model, content_sha256, embedding) VALUES ($1, $2, $3::vector) ON CONFLICT DO NOTHING",
      [embeddingModel, queryKey, `[${values.join(",")}]`],
    );
  }
  const vector = `[${values.join(",")}]`;
  const result = await pool.query<{ file_path: string; content: string; distance: number }>(
    `SELECT file_path, content, (embedding <=> $2::vector)::float AS distance
     FROM repository_chunks
     WHERE repository = $1 AND ($4::text IS NULL OR commit_sha = $4)
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [repository, vector, limit, commitSha ?? null],
  );
  return {
    chunks: result.rows.map((row) => ({ path: row.file_path, content: row.content, distance: row.distance })),
    embeddingUsage,
  };
}

export async function retrieveRepositoryContext(repository: string, diff: string) {
  const result = await retrieveRepositoryContextDetailed(repository, diff);
  return result.chunks;
}

const testPath = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[^/]+$/i;

export function isTestPath(path: string) {
  return testPath.test(path);
}

/**
 * True when every removed ('-') and context (' ') line the diff shows for `path` is present at its old line number in
 * `content`, i.e. `content` really is the pre-change side of this diff.
 */
export function diffAppliesToFile(diff: string, path: string, content: string) {
  const lines = content.split(/\r?\n/);
  let inFile = false;
  let oldLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) { inFile = false; continue; }
    if (line.startsWith("--- ")) { inFile = line === `--- a/${path}`; continue; }
    if (!inFile || line.startsWith("+++ ")) continue;
    const header = /^@@ -(\d+)/.exec(line);
    if (header) { oldLine = Number(header[1]); continue; }
    if (line.startsWith("-") || line.startsWith(" ")) {
      if (lines[oldLine - 1] !== line.slice(1)) return false;
      oldLine += 1;
    }
  }
  return true;
}

/** Full text of each source file changed by the diff, read at the given commit (the pre-change side when that commit is the base). */
export async function getChangedFileContext(owner: string, repository: string, commitSha: string, diff: string, options: { excludeTests?: boolean } = {}) {
  const paths = [...new Set([...diff.matchAll(/^--- a\/(.+)$/gm)].map((match) => match[1].trim()))]
    .filter((path) => supportedSource.test(path) && !ignoredPath.test(path) && !(options.excludeTests && testPath.test(path)));
  const files: { path: string; content: string }[] = [];
  for (const path of paths) {
    try {
      const content = await getRawRepositoryFile(owner, repository, commitSha, path);
      if (content.length <= maxFileBytes) files.push({ path, content });
    } catch {
      // A file added by the diff does not exist at the base commit.
    }
  }
  return files;
}

/** The single commit the repository is currently indexed at, or null when nothing is indexed. */
export async function getIndexedCommit(repository: string) {
  const pool = await ensureDatabaseSchema();
  const result = await pool.query<{ commit_sha: string }>("SELECT DISTINCT commit_sha FROM repository_chunks WHERE repository = $1", [repository]);
  return result.rows.length === 1 ? result.rows[0].commit_sha : null;
}
