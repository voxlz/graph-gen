// benchmark.ts — compare layout engines (default: curved vs Cola) on a folder
// of graphs.
// Usage: tsx src/benchmark.ts [inputDir=examples] [outputDir=<inputDir>/renders]
//
// Every .ggn file under inputDir is rendered with each engine in BENCH_ENGINES
// (as PNG plus a GRAPHGEN_DUMP layout dump). Metrics per render:
//   area      rendered PNG area in megapixels
//   edgeLen   total drawn edge length (border to border, along curves/bends)
//   maxEdge   longest visible edge
//   cross     number of edge/edge crossings
//   through   number of edges passing through a non-endpoint node
//   labelHits labels overlapping a node or another label
//   labelLines labels crossed by an edge
//   overlaps  edge pairs drawn on top of each other along a shared stretch
//   bends     total 90°/polyline bends (curves count as 0), maxBends per edge
// A summary of first-engine/second-engine ratios is printed and written to
// <outputDir>/benchmark.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool, renderAndMeasure, type Metrics } from "./metrics";

const inputDir = path.resolve(process.argv[2] ?? "examples");
const outputDir = path.resolve(
  process.argv[3] ?? path.join(inputDir, "renders"),
);
const engines = (process.env.BENCH_ENGINES ?? "curved,cola").split(",");
const filter = process.env.BENCH_FILTER
  ? new RegExp(process.env.BENCH_FILTER)
  : null;

function filesIn(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return file === outputDir ? [] : filesIn(file);
    return entry.name.endsWith(".ggn") ? [file] : [];
  });
}

// Cola output never changes while iterating on the constraint engine, so its
// metrics are cached next to the render (set BENCH_FRESH=1 to redo).
async function run(file: string, engine: string): Promise<Metrics> {
  const rel = path.relative(inputDir, file).replace(/\.ggn$/, "");
  const cacheFile = path.join(outputDir, `${rel}_${engine}.metrics.json`);
  if (
    engine === "cola" &&
    !process.env.BENCH_FRESH &&
    fs.existsSync(cacheFile)
  ) {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  }
  const metrics = await renderAndMeasure(
    file,
    path.join(outputDir, `${rel}_${engine}.png`),
    { GRAPHGEN_LAYOUT: engine },
  );
  if (metrics.ok) fs.writeFileSync(cacheFile, JSON.stringify(metrics));
  else fs.rmSync(cacheFile, { force: true });
  return metrics;
}

function geomean(values: number[]) {
  const finite = values.filter((v) => Number.isFinite(v) && v > 0);
  if (finite.length === 0) return NaN;
  return Math.exp(finite.reduce((s, v) => s + Math.log(v), 0) / finite.length);
}

async function main() {
  const files = filesIn(inputDir)
    .filter((f) => !filter || filter.test(path.relative(inputDir, f)))
    .sort();
  const jobs = files.flatMap((file) =>
    engines.map((engine) => ({ file, engine })),
  );
  const concurrency = Number(
    process.env.BENCH_JOBS ?? Math.max(1, os.cpus().length - 1),
  );
  const results = await pool(jobs, concurrency, ({ file, engine }) =>
    run(file, engine),
  );

  const rows: Record<string, Record<string, Metrics>> = {};
  jobs.forEach(({ file, engine }, i) => {
    const rel = path.relative(inputDir, file);
    (rows[rel] ??= {})[engine] = results[i];
  });

  const [a, b] = engines;
  const fmt = (n: number, d = 0) => n.toFixed(d).padStart(7);
  console.log(
    `${"graph".padEnd(34)} ${"area".padStart(15)} ${"edgeLen".padStart(15)} ${"maxEdge".padStart(15)} ${"cross".padStart(9)} ${"through".padStart(9)} ${"ms".padStart(13)}`,
  );
  const ratios = {
    area: [] as number[],
    edgeLen: [] as number[],
    maxEdge: [] as number[],
    ms: [] as number[],
  };
  let worse = 0;
  let failures = 0;
  const totals = {
    [a]: { cross: 0, through: 0 },
    [b]: { cross: 0, through: 0 },
  };
  for (const [rel, r] of Object.entries(rows)) {
    const x = r[a];
    const y = r[b];
    if (!x?.ok || !y?.ok) {
      failures++;
      console.log(
        `${rel.padEnd(34)} FAILED ${a}: ${x?.error ?? "ok"} | ${b}: ${y?.error ?? "ok"}`,
      );
      continue;
    }
    if (y) {
      ratios.area.push(x.area / y.area);
      ratios.ms.push(x.ms / y.ms);
      if (y.edgeLen > 0) ratios.edgeLen.push(x.edgeLen / y.edgeLen);
      if (y.maxEdge > 0) ratios.maxEdge.push(x.maxEdge / y.maxEdge);
      totals[a].cross += x.cross;
      totals[a].through += x.through;
      totals[b].cross += y.cross;
      totals[b].through += y.through;
    }
    const flag =
      y && (x.area > y.area * 1.05 || x.edgeLen > y.edgeLen * 1.05) ? " *" : "";
    if (flag) worse++;
    console.log(
      `${rel.padEnd(34)} ${fmt(x.area, 2)}/${fmt(y?.area ?? 0, 2)} ${fmt(x.edgeLen)}/${fmt(y?.edgeLen ?? 0)} ${fmt(x.maxEdge)}/${fmt(y?.maxEdge ?? 0)} ${String(x.cross).padStart(4)}/${String(y?.cross ?? 0).padEnd(4)} ${String(x.through).padStart(4)}/${String(y?.through ?? 0).padEnd(4)} ${fmt(x.ms)}/${fmt(y?.ms ?? 0)} ${fmt(x.layoutMs ?? 0)}/${fmt(y?.layoutMs ?? 0)}${flag}`,
    );
  }
  const summary = {
    graphs: Object.keys(rows).length,
    failures,
    worseThan5pct: worse,
    geomeanAreaRatio: geomean(ratios.area),
    geomeanEdgeLenRatio: geomean(ratios.edgeLen),
    geomeanMaxEdgeRatio: geomean(ratios.maxEdge),
    geomeanTimeRatio: geomean(ratios.ms),
    totalMs: Object.fromEntries(
      engines.map((engine) => [
        engine,
        Object.values(rows).reduce((t, r) => t + (r[engine]?.ms ?? 0), 0),
      ]),
    ),
    totals,
  };
  console.log(`\n${a}/${b} summary:`, JSON.stringify(summary, null, 2));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "benchmark.json"),
    JSON.stringify({ summary, rows }, null, 2),
  );
}

void main();
