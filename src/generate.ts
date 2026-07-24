// generate.ts
// Render one or more graphs from explicit input/output path pairs.
//
// Usage:
//   tsx src/generate.ts <input1> <output1> [<input2> <output2> ...]
//
// Example:
//   tsx src/generate.ts demo/usecases/bookstore_uc1.ggn out/bookstore_uc1.png \
//                     demo/scopes/weather_scope.ggn  out/weather_scope.png
//
// Each pair is rendered by index.ts. Missing input files or an odd number of
// arguments are reported and cause a non-zero exit.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

if (args.length === 0 || args.length % 2 !== 0) {
  console.error(
    "Usage: tsx src/generate.ts <input1> <output1> [<input2> <output2> ...]",
  );
  process.exit(1);
}

const pairs: Array<{ input: string; output: string }> = [];
for (let i = 0; i < args.length; i += 2) {
  pairs.push({ input: args[i], output: args[i + 1] });
}

let failures = 0;
for (const { input, output } of pairs) {
  if (!fs.existsSync(input)) {
    console.error(`[skip] input not found: ${input}`);
    failures++;
    continue;
  }
  const outDir = path.dirname(output);
  if (outDir && outDir !== ".") fs.mkdirSync(outDir, { recursive: true });
  try {
    execFileSync("tsx", [path.join(__dirname, "index.ts"), input, output], {
      stdio: "inherit",
      cwd: path.resolve(__dirname, ".."),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[fail] ${input} -> ${output}: ${message}`);
    failures++;
  }
}

const ok = pairs.length - failures;
console.log(`\nGenerated ${ok}/${pairs.length} image(s).`);
if (failures > 0) process.exit(1);
