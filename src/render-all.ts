// render-all.ts
// Renders every example graph into renders/, mirroring the source folder:
//   graph.ggn                 -> renders/graph.png, renders/graph_cola.png
//   demo/showcase/overlap.ggn -> renders/demo/showcase/overlap.png, ..._cola.png
//   scopes/asrv_scope.ggn     -> renders/scopes/asrv_scope.png, ..._cola.png
//   example/parsedGraph...json-> renders/example/parsedGraphExample.png, ..._cola.png
// Usage: tsx src/render-all.ts

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "renders");
const cachePath = path.join(outDir, ".render-cache.json");
fs.mkdirSync(outDir, { recursive: true });

function filesIn(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

function importedFiles(file: string, seen = new Set<string>()): string[] {
  const absolutePath = path.resolve(rootDir, file);
  if (seen.has(absolutePath) || !fs.existsSync(absolutePath)) return [];
  seen.add(absolutePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  const imports =
    path.extname(absolutePath) === ".ggn"
      ? [...source.matchAll(/(^|\n)\s*import\s+"([^"]+)"/g)].map(
          (match) => match[2],
        )
      : [...source.matchAll(/"imports"\s*:\s*\[([\s\S]*?)\]/g)].flatMap(
          (match) =>
            [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]),
        );
  return [
    absolutePath,
    ...imports.flatMap((imported) =>
      importedFiles(path.resolve(path.dirname(absolutePath), imported), seen),
    ),
  ];
}

function fingerprint(files: string[], prefix = ""): string {
  const hash = createHash("sha256");
  hash.update(prefix);
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    hash.update(fs.readFileSync(file));
  }
  return hash.digest("hex");
}

function readCache(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return {};
  }
}

// graph.ggn at the root (if present), every DSL graph under demo/ and scopes/,
// and the JSON example
const inputs: string[] = [];
if (fs.existsSync(path.join(rootDir, "graph.ggn"))) inputs.push("graph.ggn");
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
    if (path.extname(f).toLowerCase() === ".ggn") {
      inputs.push(path.join(dir, f));
    }
  }
}
const jsonExample = path.join("example", "parsedGraphExample.json");
if (fs.existsSync(path.join(rootDir, jsonExample))) inputs.push(jsonExample);

const ext = ["p", "n", "g"].join(""); // built so the literal isn't in source noise
const renderFiles = [
  ...filesIn(path.join(rootDir, "src")).filter((file) => file.endsWith(".ts")),
  ...["style.jsonc", "style.json"]
    .map((file) => path.join(rootDir, file))
    .filter(fs.existsSync),
];
const renderFingerprint = fingerprint(renderFiles);
const cache = readCache();
let rendered = 0;
let skipped = 0;
for (const input of inputs) {
  const subDir = path.dirname(input); // "." for root files, else a source subdirectory
  const base = path.basename(input).replace(/\.(ggn|json)$/i, "");
  const destDir = subDir === "." ? outDir : path.join(outDir, subDir);
  fs.mkdirSync(destDir, { recursive: true });
  const outputs = [
    path.join(destDir, `${base}.${ext}`),
    path.join(destDir, `${base}_cola.${ext}`),
  ];
  const inputFingerprint = fingerprint(importedFiles(input), renderFingerprint);
  if (
    cache[input] === inputFingerprint &&
    outputs.every((output) => fs.existsSync(output))
  ) {
    skipped += outputs.length;
    continue;
  }
  for (const [layout, suffix] of [
    ["constraint", ""],
    ["cola", "_cola"],
  ] as const) {
    const output = path.join(destDir, `${base}${suffix}.${ext}`);
    // index.ts formats every DSL input before parsing and rendering it.
    execFileSync("tsx", ["src/index.ts", input, output], {
      stdio: "inherit",
      cwd: rootDir,
      env: { ...process.env, GRAPHGEN_LAYOUT: layout },
    });
  }
  cache[input] = inputFingerprint;
  rendered += outputs.length;
}
fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);

console.log(
  `\nRendered ${rendered} image(s), skipped ${skipped} unchanged image(s) under ${outDir}`,
);
