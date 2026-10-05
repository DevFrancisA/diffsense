import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const missing: string[] = [];
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");

  if (missing.length === 0) {
    try {
      const { getPool } = await import("@/lib/server/database");
      await getPool().query("SELECT 1");
    } catch {
      missing.push("reachable PostgreSQL database");
    }
  }

  return NextResponse.json({ ready: missing.length === 0, missing });
}
