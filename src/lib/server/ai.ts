import OpenAI from "openai";

export type ApiTokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number };

export interface OpenAIBudget {
  beforeBatch(label: string, apiCalls: number, estimatedTokens: number): Promise<void>;
  recordUsage(label: string, usage: ApiTokenUsage): Promise<void>;
}

export function estimateTokens(text: string) {
  return Math.ceil(text.length / 3);
}

export function getOpenAIClient(options: { maxRetries?: number } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");
  return new OpenAI({ apiKey, ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }) });
}

export const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
