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
import { renderErrorGraph, renderGraph } from "./render";
import { validateGraph, type DiagnosticLocation } from "./validate";

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

function setSourceFile(spec: GraphSpec, file: string) {
  for (const item of [
    ...spec.nodes,
    ...spec.boundaries,
    ...spec.edges,
    ...spec.constraints,
  ]) {
    item.sourceFile = file;
  }
}

function locateParseError(file: string, error: string) {
  const match = error.match(/ at line (\d+)$/);
  const line = match ? Number(match[1]) : 1;
  const message = match ? error.slice(0, match.index) : error;
  return `${file}:${line}: ${message}`;
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
          errors: formatted.errors.map((error) =>
            locateParseError(file, error),
          ),
        };
      }
      const parsed = parseGraphText(formatted.formatted);
      setSourceFile(parsed.spec, file);
      return {
        ...parsed,
        errors: parsed.errors.map((error) => locateParseError(file, error)),
      };
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
    return { spec: emptyGraphSpec(), errors: [`${file}:1: ${message}`] };
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

function writeResult(result: Promise<{ width: number; height: number }>) {
  result
    .then(({ width, height }) => {
      console.log(`Wrote ${outputPath} (${width}x${height})`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to render ${outputPath}: ${message}`);
      process.exitCode = 1;
    });
}

function formatDiagnostic(
  category: string,
  message: string,
  location: DiagnosticLocation = {},
) {
  const file = location.file ?? inputPath;
  const line = location.line ?? 1;
  const header = `[${category}] ${file}:${line}`;
  const diagnostic = `${header}\nERROR: ${message}`;
  try {
    const sourceLines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const first = Math.max(1, line - 2);
    const last = Math.min(sourceLines.length, line + 2);
    const context = sourceLines
      .slice(first - 1, last)
      .map((source, index) => {
        const sourceLine = first + index;
        const marker = sourceLine === line ? ">" : " ";
        return `${marker} ${String(sourceLine).padStart(4)} | ${source}`;
      })
      .join("\n");
    return context ? `${diagnostic}\nContext:\n${context}` : diagnostic;
  } catch {
    return diagnostic;
  }
}

function formatParseDiagnostic(error: string) {
  const match = error.match(/^(.*):(\d+):\s*(.*)$/);
  if (!match) return `[parse]\nERROR: ${error}`;
  return formatDiagnostic("parse", match[3], {
    file: match[1],
    line: Number(match[2]),
  });
}

const loaded = loadSpec(inputPath);
if (loaded.errors.length > 0) {
  const errors = loaded.errors.map(formatParseDiagnostic);
  for (const error of errors) console.error(error);
  writeResult(renderErrorGraph(errors, outputPath));
} else {
  const spec = loaded.spec;
  if (spec.warnings.length) {
    for (const warning of spec.warnings) console.warn(`[parse] ${warning}`);
  }
  const validation = validateGraph(spec);
  const errors = validation.errors.map((error, index) =>
    formatDiagnostic("validate", error, validation.locations[index]),
  );
  for (const error of errors) console.error(error);
  writeResult(
    errors.length > 0
      ? renderErrorGraph(errors, outputPath)
      : renderGraph(spec, outputPath, stylePath),
  );
}
