// render-all.js
// Renders every sample/test graph into renders/, mirroring the source folder:
//   graph.txt                 -> renders/graph.png
//   tests/overlap.txt         -> renders/tests/overlap.png
//   scopes/asrv_scope.txt     -> renders/scopes/asrv_scope.png
//   example/parsedGraph...json-> renders/example/parsedGraphExample.png
// Usage: node render-all.js

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const outDir = path.join(__dirname, "renders");
fs.mkdirSync(outDir, { recursive: true });

// graph.txt at the root (if present), every *.txt under tests/ and scopes/, and the JSON example
const inputs = [];
if (fs.existsSync(path.join(__dirname, "graph.txt"))) inputs.push("graph.txt");
for (const dir of [
  "tests",
  "scopes",
  "usecases",
  "demo",
  "demo/scopes",
  "demo/usecases",
]) {
  const d = path.join(__dirname, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).sort()) {
    if (f.toLowerCase().endsWith(".txt")) inputs.push(path.join(dir, f));
  }
}
const jsonExample = path.join("example", "parsedGraphExample.json");
if (fs.existsSync(path.join(__dirname, jsonExample))) inputs.push(jsonExample);

const ext = ["p", "n", "g"].join(""); // built so the literal isn't in source noise
for (const input of inputs) {
  const subDir = path.dirname(input); // "." for root files, else "tests"/"scopes"/"example"
  const base = path.basename(input).replace(/\.(txt|json)$/i, "");
  const destDir = subDir === "." ? outDir : path.join(outDir, subDir);
  fs.mkdirSync(destDir, { recursive: true });
  const output = path.join(destDir, `${base}.${ext}`);
  execFileSync("node", ["index.js", input, output], {
    stdio: "inherit",
    cwd: __dirname,
  });
}

console.log(`\nRendered ${inputs.length} image(s) under ${outDir}`);
