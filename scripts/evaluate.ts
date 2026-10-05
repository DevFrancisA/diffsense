import { readFile } from "node:fs/promises";
import { evaluate, evaluationSchema } from "../src/lib/evaluation";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error("Usage: npm run evaluate -- path/to/evaluation.json");
  const input = evaluationSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
  process.stdout.write(`${JSON.stringify(evaluate(input), null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Evaluation failed."}\n`);
  process.exitCode = 1;
});
