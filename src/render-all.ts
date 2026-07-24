// render-all.ts
// Renders every example graph into renders/, mirroring the source folder:
//   graph.txt                 -> renders/graph.png
//   demo/showcase/overlap.txt -> renders/demo/showcase/overlap.png
//   scopes/asrv_scope.txt     -> renders/scopes/asrv_scope.png
//   example/parsedGraph...json-> renders/example/parsedGraphExample.png
// Usage: tsx src/render-all.ts

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "renders");
fs.mkdirSync(outDir, { recursive: true });

// graph.txt at the root (if present), every *.txt under demo/ and scopes/, and the JSON example
const inputs: string[] = [];
if (fs.existsSync(path.join(rootDir, "graph.txt"))) inputs.push("graph.txt");
for (const dir of [
  "scopes",
  "usecases",
  "demo",
  "demo/showcase",
  "demo/scopes",
  "demo/usecases",
]) {
  const d = path.join(rootDir, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).sort()) {
    if (f.toLowerCase().endsWith(".txt")) inputs.push(path.join(dir, f));
  }
}
const jsonExample = path.join("example", "parsedGraphExample.json");
if (fs.existsSync(path.join(rootDir, jsonExample))) inputs.push(jsonExample);

const ext = ["p", "n", "g"].join(""); // built so the literal isn't in source noise
for (const input of inputs) {
  const subDir = path.dirname(input); // "." for root files, else a source subdirectory
  const base = path.basename(input).replace(/\.(txt|json)$/i, "");
  const destDir = subDir === "." ? outDir : path.join(outDir, subDir);
  fs.mkdirSync(destDir, { recursive: true });
  const output = path.join(destDir, `${base}.${ext}`);
  // index.ts formats every .txt input before parsing and rendering it.
  execFileSync("tsx", ["src/index.ts", input, output], {
    stdio: "inherit",
    cwd: rootDir,
  });
}

console.log(`\nRendered ${inputs.length} image(s) under ${outDir}`);
