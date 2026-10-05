import { embeddingModel, getOpenAIClient } from "@/lib/server/ai";
import { ensureDatabaseSchema } from "@/lib/server/database";
import { getRawRepositoryFile, getRepositoryTree } from "@/lib/server/github";

const supportedSource = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|php|py|rb|rs|sql|svelte|ts|tsx|vue)$/i;
const ignoredPath = /(?:^|\/)(?:node_modules|vendor|dist|build|\.next|coverage|\.git|\.venv)(?:\/|$)|(?:\.min\.|\.lock\.)/i;
const maxFiles = 40;
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

export async function indexRepository(owner: string, repository: string, ref?: string) {
  const [tree, pool, openai] = await Promise.all([
    getRepositoryTree(owner, repository, ref),
    ensureDatabaseSchema(),
    Promise.resolve(getOpenAIClient()),
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

  const embeddings: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += 64) {
    const batch = chunks.slice(offset, offset + 64);
    const response = await openai.embeddings.create({
      model: embeddingModel,
      input: batch.map((chunk) => `${chunk.path}\n${chunk.content}`),
      dimensions: 1536,
    });
    const ordered = response.data.sort((left, right) => left.index - right.index);
    embeddings.push(...ordered.map((item) => item.embedding));
  }

  const repositoryKey = `${owner}/${repository}`.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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

  return { repository: repositoryKey, commitSha: tree.commitSha, branch: tree.branch, filesIndexed: files.length, chunksIndexed: chunks.length };
}

export async function retrieveRepositoryContext(repository: string, diff: string) {
  const openai = getOpenAIClient();
  const embedding = await openai.embeddings.create({ model: embeddingModel, input: diff.slice(0, 12_000), dimensions: 1536 });
  const vector = `[${embedding.data[0].embedding.join(",")}]`;
  const pool = await ensureDatabaseSchema();
  const result = await pool.query<{ file_path: string; content: string; distance: number }>(
    `SELECT file_path, content, (embedding <=> $2::vector)::float AS distance
     FROM repository_chunks
     WHERE repository = $1
     ORDER BY embedding <=> $2::vector
     LIMIT 8`,
    [repository, vector],
  );
  return result.rows.map((row) => ({ path: row.file_path, content: row.content, distance: row.distance }));
}
