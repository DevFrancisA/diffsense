import { Pool } from "pg";

declare global {
  var diffSensePool: Pool | undefined;
}

export function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");
  globalThis.diffSensePool ??= new Pool({ connectionString, max: 8 });
  return globalThis.diffSensePool;
}

export async function ensureDatabaseSchema() {
  const pool = getPool();
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS repository_chunks (
      repository text NOT NULL,
      commit_sha text NOT NULL,
      file_path text NOT NULL,
      chunk_index integer NOT NULL,
      content text NOT NULL,
      embedding vector(1536) NOT NULL,
      indexed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (repository, commit_sha, file_path, chunk_index)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS repository_chunks_embedding_idx
    ON repository_chunks USING hnsw (embedding vector_cosine_ops)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS repository_chunks_repository_idx
    ON repository_chunks (repository)
  `);
  return pool;
}
