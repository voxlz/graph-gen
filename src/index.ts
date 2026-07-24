// index.ts
// Usage: tsx src/index.ts <input.ggn|input.json> <output.png> [style.jsonc]
//
// Pipeline:
//  1. Format and load the graph spec. A .ggn input is normalized by format.ts
//     and parsed by parse.ts into the intermediate JSON representation; a .json
//     input is treated as that representation directly.
//  2. Validate constraints and hand the resulting spec to render.ts.

import fs from "node:fs";
import path from "node:path";
import { formatGraphFile } from "./format";
import {
  emptyGraphSpec,
  parseGraphText,
  stripComments,
  type GraphSpec,
  type ParseResult,
} from "./parse";
import { renderGraph } from "./render";
import { validateGraph } from "./validate";

const inputPath = process.argv[2] || "graph.ggn";
const outputPath = process.argv[3] || "output.png";
// Optional: a custom global style file (falls back to style.jsonc/style.json).
const stylePath = process.argv[4];

// --- tolerant JSON (allows // comments and trailing commas) -----------------
function parseJsonc(text: string): any {
  const noComments = stripComments(text);
  const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noTrailingCommas);
}

// --- load spec (parse DSL or read intermediate JSON), resolving imports -----
function parseFile(file: string): ParseResult {
  try {
    const extension = path.extname(file).toLowerCase();
    if (extension === ".ggn") {
      const formatted = formatGraphFile(file);
      if (formatted.errors.length > 0) {
        return {
          spec: emptyGraphSpec(),
          errors: formatted.errors.map((error) => `${file}: ${error}`),
        };
      }
      return parseGraphText(formatted.formatted);
    }
    if (extension !== ".json") {
      return {
        spec: emptyGraphSpec(),
        errors: [`${file}: unsupported graph input extension: ${extension}`],
      };
    }
    const raw = fs.readFileSync(file, "utf8");
    const data = parseJsonc(raw);
    return {
      spec: {
        ...emptyGraphSpec(),
        ...data,
        graph: { ...emptyGraphSpec().graph, ...(data.graph || {}) },
        shapes: data.shapes || {},
        nodes: data.nodes || [],
        boundaries: data.boundaries || [],
        edges: data.edges || [],
        constraints: data.constraints || [],
        imports: data.imports || [],
        warnings: data.warnings || [],
      },
      errors: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { spec: emptyGraphSpec(), errors: [`${file}: ${message}`] };
  }
}

// Merge `src` into `target`. Imported graphs contribute nodes / boundaries /
// constraints / shapes / graph settings; edges are only taken when includeEdges
// is true (so an importer keeps its own edges, not the base graph's).
function mergeSpec(target: GraphSpec, src: GraphSpec, includeEdges: boolean) {
  Object.assign(target.graph, src.graph || {});
  for (const [name, style] of Object.entries(src.shapes || {})) {
    target.shapes[name] = {
      ...(target.shapes[name] || {}),
      ...(style as Record<string, string | number>),
    };
  }
  const nodeIds = new Set(target.nodes.map((n: any) => n.id));
  for (const n of src.nodes || []) {
    if (!nodeIds.has(n.id)) {
      target.nodes.push(n);
      nodeIds.add(n.id);
    }
  }
  const bIds = new Set(target.boundaries.map((b: any) => b.id));
  for (const b of src.boundaries || []) {
    if (!bIds.has(b.id)) {
      target.boundaries.push(b);
      bIds.add(b.id);
    }
  }
  target.constraints.push(...(src.constraints || []));
  if (includeEdges) target.edges.push(...(src.edges || []));
  target.warnings.push(...(src.warnings || []));
}

function loadSpec(file: string, seen = new Set<string>()): ParseResult {
  const abs = path.resolve(file);
  const parsed = parseFile(abs);
  if (parsed.errors.length > 0) return parsed;
  const spec = parsed.spec;
  if (spec.imports.length === 0) return parsed;

  seen.add(abs);
  const merged = emptyGraphSpec();
  const dir = path.dirname(abs);
  for (const imp of spec.imports) {
    const impAbs = path.resolve(dir, imp);
    if (seen.has(impAbs)) {
      merged.warnings.push(`circular import skipped: ${imp}`);
      continue;
    }
    const imported = loadSpec(impAbs, seen);
    if (imported.errors.length > 0) return imported;
    mergeSpec(merged, imported.spec, false); // base: no edges
  }
  mergeSpec(merged, spec, true); // this file's own edges (and extras) on top
  return { spec: merged, errors: [] };
}

const loaded = loadSpec(inputPath);
if (loaded.errors.length > 0) {
  for (const error of loaded.errors) console.error(`[parse] ${error}`);
  process.exit(1);
}
const spec = loaded.spec;
if (spec.warnings.length) {
  for (const w of spec.warnings) console.warn(`[parse] ${w}`);
}
for (const error of validateGraph(spec).errors) {
  console.error(`[validate] ${error}`);
}

renderGraph(spec, outputPath, stylePath)
  .then(({ width, height }) => {
    console.log(`Wrote ${outputPath} (${width}x${height})`);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to render ${outputPath}: ${message}`);
    process.exitCode = 1;
  });
