// parse.ts
// Parses the graph DSL (*.ggn) into the intermediate JSON representation
// consumed by index.ts. The intermediate shape mirrors parsedGraphExample.json:
//
//   {
//     graph:       { title, minGap, lines },
//     shapes:      { <shapeName>: { ...styleOverrides } },
//     nodes:       [ { id, label, shape, parent } ],
//     boundaries:  [ { id, label, parent } ],
//     edges:       [ { source, target, label, arrowSource, arrowTarget, lineStyle } ],
//     constraints: [ { type, a, b } ]
//   }
//
// The DSL is intentionally forgiving: unknown lines are warned about and skipped
// rather than aborting the whole parse.

export interface GraphSpec {
  graph: Record<string, string | number | null>;
  shapes: Record<string, Record<string, string | number>>;
  nodes: any[];
  boundaries: any[];
  edges: any[];
  constraints: any[];
  imports: string[];
  warnings: string[];
}

export interface ParseResult {
  spec: GraphSpec;
  errors: string[];
}

function emptyGraphSpec(): GraphSpec {
  return {
    graph: {},
    shapes: {},
    nodes: [],
    boundaries: [],
    edges: [],
    constraints: [],
    imports: [],
    warnings: [],
  };
}

// --- comment stripping (string-aware) ---------------------------------------
// Removes // line comments and /* */ block comments without touching text that
// lives inside double-quoted strings.
function stripComments(text: string) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '"' && text[i - 1] !== "\\") inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

// --- balanced-brace block extraction ----------------------------------------
// Given text and the index of an opening "{", returns { body, end } where body
// is the text between the braces and end is the index just past the closing "}".
function extractBlock(text: string, openIdx: number) {
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '"' && text[i - 1] !== "\\") inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return { body: text.slice(openIdx + 1, i), end: i + 1 };
      }
    }
  }
  const line = text.slice(0, openIdx).split("\n").length;
  throw new Error(`Unbalanced braces in DSL block at line ${line}`);
}

function lineNumber(text: string, index: number, startLine: number) {
  return startLine + text.slice(0, index).split("\n").length - 1;
}

// --- id slugification for label-only declarations ---------------------------
function slug(label: string) {
  const s = label
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join("");
  return s || "node";
}

// --- node/boundary header parsing -------------------------------------------
// Accepts: `id`, `id: "label"`, `id: label`, `"label" as id`, `"label"`.
function parseHeader(header: string) {
  const h = header.trim();
  let m;
  if ((m = h.match(/^"(.+)"\s+as\s+(\S+)$/))) return { id: m[2], label: m[1] };
  if ((m = h.match(/^(\S+)\s*:\s*"(.+)"$/))) return { id: m[1], label: m[2] };
  if ((m = h.match(/^(\S+)\s*:\s*(.+)$/)))
    return { id: m[1], label: m[2].trim() };
  if ((m = h.match(/^"(.+)"$/))) {
    const label = m[1];
    return { id: slug(label), label };
  }
  if ((m = h.match(/^(\S+)$/))) return { id: m[1], label: m[1] };
  return null;
}

// --- nodes block (recursive, handles nested boundaries) ---------------------
function parseNodesBlock(
  body: string,
  parent: string | null,
  nodes: any[],
  boundaries: any[],
  warnings: string[],
  startLine: number,
) {
  let i = 0;
  while (i < body.length) {
    // find the next non-whitespace
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;

    // read the statement header up to a "{" (boundary) or newline (leaf)
    let j = i;
    let braceIdx = -1;
    let inString = false;
    while (j < body.length) {
      const c = body[j];
      if (inString) {
        if (c === '"' && body[j - 1] !== "\\") inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === "{") {
        braceIdx = j;
        break;
      } else if (c === "\n") {
        break;
      }
      j++;
    }

    const rawHeader = body.slice(i, braceIdx === -1 ? j : braceIdx).trim();
    if (!rawHeader) {
      i = j + 1;
      continue;
    }

    const spaceIdx = rawHeader.search(/\s/);
    const shape = (
      spaceIdx === -1 ? rawHeader : rawHeader.slice(0, spaceIdx)
    ).trim();
    const rest = spaceIdx === -1 ? "" : rawHeader.slice(spaceIdx).trim();
    const line = lineNumber(body, i, startLine);

    if (braceIdx !== -1) {
      // boundary / group with children. `group` behaves like a boundary for
      // layout and constraints but is not drawn (no border, no label).
      const parsed = parseHeader(rest) || {
        id: slug(rest || "boundary"),
        label: rest,
      };
      boundaries.push({
        id: parsed.id,
        label: parsed.label,
        shape,
        parent,
        draw: shape !== "group",
        line,
      });
      const { body: inner, end } = extractBlock(body, braceIdx);
      parseNodesBlock(
        inner,
        parsed.id,
        nodes,
        boundaries,
        warnings,
        lineNumber(body, braceIdx, startLine),
      );
      i = end;
    } else {
      const parsed = parseHeader(rest);
      if (!parsed) {
        warnings.push(`Could not parse node declaration: "${rawHeader}"`);
      } else {
        nodes.push({ id: parsed.id, label: parsed.label, shape, parent, line });
      }
      i = j + 1;
    }
  }
}

// --- shapes block (style overrides expressed in the DSL) --------------------
function parseShapesBlock(
  body: string,
  shapes: Record<string, Record<string, string | number>>,
  warnings: string[],
) {
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;

    // shapeName { ... }
    let j = i;
    while (j < body.length && !/\s|\{/.test(body[j])) j++;
    const shapeName = body.slice(i, j).trim();
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] !== "{") {
      warnings.push(`Expected "{" after shape "${shapeName}" in shapes block`);
      i = j + 1;
      continue;
    }
    const { body: inner, end } = extractBlock(body, j);
    const style: Record<string, string | number> = {};
    for (const line of inner.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const m = t.match(/^(\w+)\s+"?([^"]*)"?$/);
      if (m) {
        let val: string | number = m[2].trim();
        if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
        style[m[1]] = val;
      } else {
        warnings.push(`Could not parse style line: "${t}"`);
      }
    }
    shapes[shapeName] = { ...(shapes[shapeName] || {}), ...style };
    i = end;
  }
}

// --- graph settings block (key value pairs) ---------------------------------
function parseSettingsBlock(
  body: string,
  target: Record<string, string | number | null>,
  warnings: string[],
) {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\w+)\s+"?([^"]*)"?$/);
    if (!m) {
      warnings.push(`Could not parse graph setting: "${line}"`);
      continue;
    }
    let val: string | number = m[2].trim();
    if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
    target[m[1]] = val;
  }
}

// --- edges block ------------------------------------------------------------
function parseEdgesBlock(
  body: string,
  edges: any[],
  warnings: string[],
  startLine: number,
) {
  for (const [index, raw] of body.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;

    // optional label suffix: ": ..." (quoted or not)
    let label = "";
    let core = line;
    const labelMatch = line.match(/:\s*(?:"([^"]*)"|(.+))\s*$/);
    if (labelMatch) {
      label = (labelMatch[1] ?? labelMatch[2] ?? "").trim();
      core = line.slice(0, labelMatch.index).trim();
    }

    const m = core.match(/^(\S+)\s+([<]?[-.]{2,}[>]?)\s+(\S+)$/);
    if (!m) {
      warnings.push(`Could not parse edge: "${line}"`);
      continue;
    }
    const [, source, connector, target] = m;
    const arrowSource = connector.startsWith("<");
    const arrowTarget = connector.endsWith(">");
    const lineStyle = connector.includes(".") ? "dotted" : "solid";
    const sourceLine = startLine + index;
    edges.push({
      source,
      target,
      label,
      arrowSource,
      arrowTarget,
      lineStyle,
      line: sourceLine,
    });
  }
}

// --- constraints block ------------------------------------------------------
function normalizeDir(dir: string) {
  return dir.toLowerCase();
}

function parseConstraintsBlock(
  body: string,
  constraints: any[],
  warnings: string[],
  startLine: number,
) {
  for (const [index, raw] of body.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;

    // alignment: `align <row|col> <id> <id> [<id> ...]`
    //   row / horizontal / y -> share a horizontal line (same y)
    //   col / column / vertical / x -> share a vertical line (same x)
    const tokens = line.split(/\s+/);
    if (tokens[0].toLowerCase() === "align") {
      const mode = (tokens[1] || "").toLowerCase();
      const ids = tokens.slice(2);
      let axis: "x" | "y" | null = null;
      if (["row", "horizontal", "y"].includes(mode)) axis = "y";
      else if (["col", "column", "vertical", "x"].includes(mode)) axis = "x";
      if (!axis) {
        warnings.push(`Unknown align mode "${tokens[1]}" in: "${line}"`);
        continue;
      }
      if (ids.length < 2) {
        warnings.push(`align needs at least two ids in: "${line}"`);
        continue;
      }
      constraints.push({ type: "align", axis, ids, line: startLine + index });
      continue;
    }

    const m = line.match(/^(\S+)\s+(\w+)\s+(\S+)$/);
    if (!m) {
      warnings.push(`Could not parse constraint: "${line}"`);
      continue;
    }
    const [, a, dir, b] = m;
    constraints.push({
      type: normalizeDir(dir),
      a,
      b,
      line: startLine + index,
    });
  }
}

// --- top-level parse --------------------------------------------------------
function parseGraphText(text: string): ParseResult {
  const cleaned = stripComments(text);
  const spec = emptyGraphSpec();

  // title "..."
  const titleMatch = cleaned.match(/(^|\n)\s*title\s+"([^"]*)"/);
  if (titleMatch) spec.graph.title = titleMatch[2];

  // import "..." directives — pull in another graph's nodes / boundaries /
  // constraints so a file can reference them and add edges on top.
  const importRe = /(^|\n)\s*import\s+"([^"]*)"/g;
  let im;
  while ((im = importRe.exec(cleaned)) !== null) spec.imports.push(im[2]);

  // named blocks: name { ... }
  try {
    const blockNames = ["graph", "shapes", "nodes", "edges", "constraints"];
    for (const name of blockNames) {
      const re = new RegExp(`(^|\\n)\\s*${name}\\s*\\{`);
      const match = cleaned.match(re);
      if (!match) continue;
      const openIdx = cleaned.indexOf("{", match.index);
      const { body } = extractBlock(cleaned, openIdx);
      const startLine = lineNumber(cleaned, openIdx, 1);
      if (name === "graph") parseSettingsBlock(body, spec.graph, spec.warnings);
      else if (name === "shapes")
        parseShapesBlock(body, spec.shapes, spec.warnings);
      else if (name === "nodes")
        parseNodesBlock(
          body,
          null,
          spec.nodes,
          spec.boundaries,
          spec.warnings,
          startLine,
        );
      else if (name === "edges")
        parseEdgesBlock(body, spec.edges, spec.warnings, startLine);
      else if (name === "constraints")
        parseConstraintsBlock(body, spec.constraints, spec.warnings, startLine);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { spec, errors: [message] };
  }

  return { spec, errors: [] };
}

export { emptyGraphSpec, parseGraphText, stripComments };
