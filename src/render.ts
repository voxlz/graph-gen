import fs from "node:fs";
import path from "node:path";
import * as cola from "webcola";
import { applyForceLayout, DEFAULT_FORCE_LAYOUT } from "./force-layout";
import { createCanvas } from "canvas";
import { stripComments, type GraphSpec } from "./parse";
import {
  directionalSlack,
  placeEdgelessAndCompact,
  shiftWithDependents,
  solveLayout,
  type LayoutSnapshot,
} from "./layout";
import {
  placeRouteLabels,
  obstacleHits,
  polylineCrossings,
  polylineLength,
  routeEdges,
  type EdgeRoute,
  type EdgeRouting,
} from "./routing";

export interface RenderResult {
  width: number;
  height: number;
}

// WebCola [userConstraint, allConstraint] iterations for the seed layout.
// Routed engines only need the global arrangement (the router absorbs the
// rest); straight edges benefit from the fully converged arrangement.
const STRESS_SEED_ITERATIONS = {
  routed: [50, 300],
  straight: [100, 1000],
  warm: [20, 150],
} as const;

const UNTANGLE_ROUNDS = 3;
// Long-edge snapping: rounds, and how many of the longest edges to try each.
// Orthogonal routing is slower per candidate, so it gets a smaller search.
const SNAP_ROUNDS = { curved: 3, orthogonal: 2 } as const;
const SNAP_EDGES = { curved: 6, orthogonal: 3 } as const;
const SNAP_UNTANGLE_TRIES = 2;
// Constraint hints: a rule counts as pressing against its limit within this
// many px, and is reported when dropping it gains at least this fraction.
const CONSTRAINT_HINT_SLACK = 1;
const CONSTRAINT_HINT_GAIN = 0.1;
const UNTANGLE_DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

interface LayoutCandidate {
  result: ReturnType<typeof solveLayout>;
  positions: Array<{ x: number; y: number }>;
  labels: Array<Record<string, number | undefined>>;
  area: number;
  edgeLength: number;
}

const LABEL_FIELDS = [
  "labelX",
  "labelY",
  "labelAnchorX",
  "labelAnchorY",
] as const;

function captureCandidate(
  nodes: any[],
  links: any[],
  result: ReturnType<typeof solveLayout>,
): LayoutCandidate {
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  const include = (r: typeof bounds) => {
    bounds.minX = Math.min(bounds.minX, r.minX);
    bounds.minY = Math.min(bounds.minY, r.minY);
    bounds.maxX = Math.max(bounds.maxX, r.maxX);
    bounds.maxY = Math.max(bounds.maxY, r.maxY);
  };
  for (const n of nodes) {
    include({
      minX: n.x - n.width / 2,
      maxX: n.x + n.width / 2,
      minY: n.y - n.height / 2,
      maxY: n.y + n.height / 2,
    });
  }
  for (const rect of result.groups.values()) include(rect);
  const endpoint = (ref: any) => (typeof ref === "number" ? nodes[ref] : ref);
  const edgeLength = links.reduce((total, link) => {
    const s = endpoint(link.source);
    const t = endpoint(link.target);
    return total + Math.hypot(s.x - t.x, s.y - t.y);
  }, 0);
  return {
    result,
    positions: nodes.map((n) => ({ x: n.x, y: n.y })),
    labels: links.map((link) =>
      Object.fromEntries(LABEL_FIELDS.map((field) => [field, link[field]])),
    ),
    area: Number.isFinite(bounds.minX)
      ? (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY)
      : 0,
    edgeLength,
  };
}

function restoreCandidate(
  nodes: any[],
  links: any[],
  candidate: LayoutCandidate,
): void {
  nodes.forEach((n, i) => Object.assign(n, candidate.positions[i]));
  links.forEach((link, i) => Object.assign(link, candidate.labels[i]));
}

// Prefer a valid layout; between valid layouts minimise area plus edge length,
// each relative to the smaller of the two candidates.
function pickBetterCandidate(
  a: LayoutCandidate,
  b: LayoutCandidate,
): LayoutCandidate {
  if (a.result.valid !== b.result.valid) return a.result.valid ? a : b;
  const ratio = (x: number, y: number) =>
    Math.min(x, y) > 0 ? x / Math.min(x, y) : 1;
  const costA = ratio(a.area, b.area) + ratio(a.edgeLength, b.edgeLength);
  const costB = ratio(b.area, a.area) + ratio(b.edgeLength, a.edgeLength);
  return costB < costA ? b : a;
}

export function formatEdgeLabel(
  template: string,
  edge: Record<string, unknown>,
  index: number,
): string {
  if (!template) return String(edge.label ?? "");

  return template.replace(/\{(\w+)\}/g, (placeholder, key) => {
    if (key === "index") return String(index + 1);
    const value = edge[key];
    return value == null ? placeholder : String(value);
  });
}

export function prepareEdges(edges: any[], labelFormat: string): any[] {
  const prepared: any[] = [];
  const byPair = new Map<string, any>();
  for (const [index, rawEdge] of edges.entries()) {
    const arrowSource = rawEdge.arrowSource ?? rawEdge.type === "leftArrow";
    const arrowTarget = rawEdge.arrowTarget ?? rawEdge.type === "rightArrow";
    const lineStyle = rawEdge.lineStyle || "solid";
    const edge = {
      ...rawEdge,
      label: rawEdge.label
        ? formatEdgeLabel(
            labelFormat,
            { ...rawEdge, arrowSource, arrowTarget, lineStyle },
            index,
          )
        : "",
      arrowSource,
      arrowTarget,
      lineStyle,
    };
    const key = [edge.source, edge.target].sort().join("\u0000");
    const existing = byPair.get(key);
    if (!existing) {
      prepared.push(edge);
      byPair.set(key, edge);
      continue;
    }
    const reversed =
      edge.source === existing.target && edge.target === existing.source;
    existing.arrowSource ||= reversed ? edge.arrowTarget : edge.arrowSource;
    existing.arrowTarget ||= reversed ? edge.arrowSource : edge.arrowTarget;
    if (edge.label) {
      existing.label = existing.label
        ? `${existing.label}\n${edge.label}`
        : edge.label;
    }
  }
  return prepared;
}

function parseJsonc(text: string): any {
  const noComments = stripComments(text);
  const noTrailingCommas = noComments.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(noTrailingCommas);
}

async function writePng(
  canvas: ReturnType<typeof createCanvas>,
  outputPath: string,
) {
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(outputPath);
    const stream = canvas.createPNGStream();
    stream.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    stream.pipe(out);
  });
}

async function writeDebugFrames(
  snapshots: LayoutSnapshot[],
  outputPath: string,
  edges: any[],
): Promise<void> {
  if (snapshots.length === 0) return;
  const margin = 50;
  const boundsFor = (snapshot: LayoutSnapshot) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of snapshot.nodes) {
      minX = Math.min(minX, node.x - node.width / 2);
      maxX = Math.max(maxX, node.x + node.width / 2);
      minY = Math.min(minY, node.y - node.height / 2);
      maxY = Math.max(maxY, node.y + node.height / 2);
    }
    for (const group of snapshot.groups) {
      if (!group.rect) continue;
      minX = Math.min(minX, group.rect.minX);
      maxX = Math.max(maxX, group.rect.maxX);
      minY = Math.min(minY, group.rect.minY);
      maxY = Math.max(maxY, group.rect.maxY);
    }
    for (const label of snapshot.labels) {
      minX = Math.min(minX, label.x - label.width / 2 - 4);
      maxX = Math.max(maxX, label.x + label.width / 2 + 4);
      minY = Math.min(minY, label.y - label.height / 2 - 2);
      maxY = Math.max(maxY, label.y + label.height / 2 + 2);
    }
    return { minX, minY, maxX, maxY };
  };
  const frameDirectory = path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath, path.extname(outputPath))}.frames`,
  );
  fs.mkdirSync(frameDirectory, { recursive: true });
  for (const snapshot of snapshots) {
    const { minX, minY, maxX, maxY } = boundsFor(snapshot);
    if (!Number.isFinite(minX)) continue;
    const width = Math.max(160, Math.ceil(maxX - minX + margin * 2));
    const height = Math.max(120, Math.ceil(maxY - minY + margin * 2));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const tx = (x: number) => x - minX + margin;
    const ty = (y: number) => y - minY + margin;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = snapshot.violations === 0 ? "#157347" : "#b42318";
    ctx.fillText(
      `${snapshot.phase === "force" ? `force iteration ${snapshot.iteration}` : snapshot.phase === "final" ? "final after minimize" : snapshot.phase === "labels" ? "labels before minimize" : `repair iteration ${snapshot.iteration}`} | violations ${snapshot.violations}`,
      10,
      10,
    );
    for (const group of snapshot.groups) {
      if (!group.rect) continue;
      ctx.strokeStyle = "#8c8c8c";
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(
        tx(group.rect.minX),
        ty(group.rect.minY),
        group.rect.maxX - group.rect.minX,
        group.rect.maxY - group.rect.minY,
      );
      ctx.setLineDash([]);
    }
    const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
    ctx.strokeStyle = "#555555";
    for (const edge of edges) {
      const sourceId =
        typeof edge.source === "number" ? edge._sourceId : edge.source.id;
      const targetId =
        typeof edge.target === "number" ? edge._targetId : edge.target.id;
      const source = nodeById.get(sourceId);
      const target = nodeById.get(targetId);
      if (!source || !target) continue;
      ctx.beginPath();
      ctx.moveTo(tx(source.x), ty(source.y));
      ctx.lineTo(tx(target.x), ty(target.y));
      ctx.stroke();
    }
    for (const node of snapshot.nodes) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#1f5f8b";
      ctx.fillRect(
        tx(node.x - node.width / 2),
        ty(node.y - node.height / 2),
        node.width,
        node.height,
      );
      ctx.strokeRect(
        tx(node.x - node.width / 2),
        ty(node.y - node.height / 2),
        node.width,
        node.height,
      );
      ctx.fillStyle = "#111111";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(node.id, tx(node.x), ty(node.y));
    }
    for (const label of snapshot.labels) {
      ctx.fillStyle = "#fff7d6";
      ctx.fillRect(
        tx(label.x - label.width / 2 - 4),
        ty(label.y - label.height / 2 - 2),
        label.width + 8,
        label.height + 4,
      );
      ctx.fillStyle = "#222222";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label.text.replace(/\n/g, " / "), tx(label.x), ty(label.y));
    }
    await writePng(
      canvas,
      path.join(
        frameDirectory,
        snapshot.phase === "final"
          ? "final.png"
          : snapshot.phase === "labels"
            ? "labels.png"
            : snapshot.phase === "force"
              ? `force-${String(snapshot.iteration).padStart(4, "0")}.png`
              : `iteration-${String(snapshot.iteration).padStart(4, "0")}.png`,
      ),
    );
  }
}

function errorGraphLines(errors: string[]): string[] {
  return errors.flatMap((error) => error.split(/\r?\n/));
}

export async function renderErrorGraph(
  errors: string[],
  outputPath: string,
): Promise<RenderResult> {
  const width = 1000;
  const padding = 40;
  const lineHeight = 24;
  const lines = errorGraphLines(errors);

  const height = Math.max(160, padding * 2 + 52 + lines.length * lineHeight);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#b42318";
  ctx.font = "bold 24px sans-serif";
  ctx.fillText("Graph generation failed", padding, padding);
  ctx.font = "16px sans-serif";
  lines.forEach((line, index) => {
    ctx.fillText(line, padding, padding + 52 + index * lineHeight);
  });

  await writePng(canvas, outputPath);
  return { width: canvas.width, height: canvas.height };
}

export async function renderGraph(
  spec: GraphSpec,
  outputPath: string,
  stylePath?: string,
): Promise<RenderResult> {
  // --- load + merge styles ----------------------------------------------------
  // style.jsonc / style.json = global defaults; spec.shapes = per-graph overrides.
  // An explicit style file (CLI arg 3) overrides the default lookup.
  const globalStyle = (() => {
    if (stylePath) {
      if (!fs.existsSync(stylePath)) {
        throw new Error(`Style file not found: ${stylePath}`);
      }
      return parseJsonc(fs.readFileSync(stylePath, "utf8"));
    }
    for (const name of ["style.jsonc", "style.json"]) {
      const p = path.join(__dirname, "..", name);
      if (fs.existsSync(p)) return parseJsonc(fs.readFileSync(p, "utf8"));
    }
    return { graph: {}, shapes: {} };
  })();

  // A last-resort default so unknown shapes still render as a plain box.
  const FALLBACK_SHAPE = {
    type: "rectangle",
    color: "#EEEEEE",
    borderColor: "#333333",
    lineStyle: "solid",
    minWidth: 100,
    minHeight: 60,
    borderRadius: 8,
  };

  const shapeStyles: Record<string, any> = {};
  const allShapeNames = new Set([
    ...Object.keys(globalStyle.shapes || {}),
    ...Object.keys(spec.shapes || {}),
  ]);
  for (const name of allShapeNames) {
    shapeStyles[name] = {
      ...FALLBACK_SHAPE,
      ...((globalStyle.shapes || {})[name] || {}),
      ...((spec.shapes || {})[name] || {}),
    };
  }
  function styleFor(shape: string): any {
    return shapeStyles[shape] || FALLBACK_SHAPE;
  }

  const graphMeta = {
    title: String(spec.graph.title ?? ""),
    minGap: spec.graph?.minGap ?? globalStyle.graph?.minGap ?? 50,
    // clear space kept between adjacent nodes (and between a node and any
    // boundary it is not a member of). Enforced by inflating node extents while
    // the solver runs, then rendering at the true size.
    nodeGap: spec.graph?.nodeGap ?? globalStyle.graph?.nodeGap ?? 26,
    // target (ideal) edge length, centre-to-centre. Kept as a flat constant so
    // hub nodes don't fling their neighbours far away (see smallgroups example).
    linkLength: spec.graph?.linkLength ?? globalStyle.graph?.linkLength ?? 110,
    // default colour for edges and arrowheads.
    lineColor:
      spec.graph?.lineColor ?? globalStyle.graph?.lineColor ?? "#000000",
    labelFormat:
      spec.graph?.labelFormat ?? globalStyle.graph?.labelFormat ?? "",
    // clear gap between a boundary's nodes and its border.
    boundaryPad:
      spec.graph?.boundaryPad ?? globalStyle.graph?.boundaryPad ?? 34,
    // extra top room inside a boundary so its label never touches its nodes.
    labelBand: spec.graph?.labelBand ?? globalStyle.graph?.labelBand ?? 20,
    // extra padding per nesting level, so a parent's label clears the border of
    // the boundary nested inside it.
    nestPad: spec.graph?.nestPad ?? globalStyle.graph?.nestPad ?? 36,
    // WebCola solver iteration counts: [unconstrained, userConstraint,
    // allConstraint]. Overridable via style or the GRAPHGEN_ITERS env var.
    iterations: spec.graph?.iterations ??
      globalStyle.graph?.iterations ?? [0, 100, 1000],
    layout: String(
      process.env.GRAPHGEN_LAYOUT ??
        spec.graph?.layout ??
        globalStyle.graph?.layout ??
        "curved",
    ).toLowerCase(),
    layoutIterations: Number(
      process.env.GRAPHGEN_LAYOUT_ITERS ??
        spec.graph?.layoutIterations ??
        globalStyle.graph?.layoutIterations ??
        1000,
    ),
    debugFrameEvery: Number(
      process.env.GRAPHGEN_DEBUG_FRAMES ??
        spec.graph?.debugFrameEvery ??
        globalStyle.graph?.debugFrameEvery ??
        0,
    ),
    forceDebugFrameEvery: Number(
      process.env.GRAPHGEN_FORCE_DEBUG_FRAMES ??
        spec.graph?.forceDebugFrameEvery ??
        globalStyle.graph?.forceDebugFrameEvery ??
        process.env.GRAPHGEN_DEBUG_FRAMES ??
        spec.graph?.debugFrameEvery ??
        globalStyle.graph?.debugFrameEvery ??
        0,
    ),
    forceNodeGapMultiplier: Math.max(
      1,
      Number(
        spec.graph?.forceNodeGapMultiplier ??
          globalStyle.graph?.forceNodeGapMultiplier ??
          1.5,
      ),
    ),
    // Warn about constraints that block a much smaller layout (curved and
    // orthogonal engines). Costs a few seconds after the image is written, so
    // it's off by default; the watcher turns it on.
    constraintHints: !["0", "false", "off", "no", ""].includes(
      String(
        process.env.GRAPHGEN_CONSTRAINT_HINTS ??
          spec.graph?.constraintHints ??
          globalStyle.graph?.constraintHints ??
          false,
      ).toLowerCase(),
    ),
    minimize: Number(
      process.env.GRAPHGEN_MINIMIZE ??
        spec.graph?.minimize ??
        globalStyle.graph?.minimize ??
        100,
    ),
    force: {
      nodeRepulsion: Number(
        spec.graph?.forceNodeRepulsion ??
          globalStyle.graph?.forceNodeRepulsion ??
          DEFAULT_FORCE_LAYOUT.nodeRepulsion,
      ),
      boundaryRepulsion: Number(
        spec.graph?.forceBoundaryRepulsion ??
          globalStyle.graph?.forceBoundaryRepulsion ??
          DEFAULT_FORCE_LAYOUT.boundaryRepulsion,
      ),
      foreignBoundaryRepulsion: Number(
        spec.graph?.forceForeignBoundaryRepulsion ??
          globalStyle.graph?.forceForeignBoundaryRepulsion ??
          DEFAULT_FORCE_LAYOUT.foreignBoundaryRepulsion,
      ),
      edgeAttraction: Number(
        spec.graph?.forceEdgeAttraction ??
          globalStyle.graph?.forceEdgeAttraction ??
          DEFAULT_FORCE_LAYOUT.edgeAttraction,
      ),
      parentAttraction: Number(
        spec.graph?.forceParentAttraction ??
          globalStyle.graph?.forceParentAttraction ??
          DEFAULT_FORCE_LAYOUT.parentAttraction,
      ),
      siblingAttraction: Number(
        spec.graph?.forceSiblingAttraction ??
          globalStyle.graph?.forceSiblingAttraction ??
          DEFAULT_FORCE_LAYOUT.siblingAttraction,
      ),
      crossingRepulsion: Number(
        spec.graph?.forceCrossingRepulsion ??
          globalStyle.graph?.forceCrossingRepulsion ??
          DEFAULT_FORCE_LAYOUT.crossingRepulsion,
      ),
      angularSeparation: Number(
        spec.graph?.forceAngularSeparation ??
          globalStyle.graph?.forceAngularSeparation ??
          DEFAULT_FORCE_LAYOUT.angularSeparation,
      ),
      edgePressure: Number(
        spec.graph?.forceEdgePressure ??
          globalStyle.graph?.forceEdgePressure ??
          DEFAULT_FORCE_LAYOUT.edgePressure,
      ),
      damping: Number(
        spec.graph?.forceDamping ??
          globalStyle.graph?.forceDamping ??
          DEFAULT_FORCE_LAYOUT.damping,
      ),
      convergenceThreshold: Number(
        spec.graph?.forceConvergenceThreshold ??
          globalStyle.graph?.forceConvergenceThreshold ??
          DEFAULT_FORCE_LAYOUT.convergenceThreshold,
      ),
      stableIterations: Number(
        spec.graph?.forceStableIterations ??
          globalStyle.graph?.forceStableIterations ??
          DEFAULT_FORCE_LAYOUT.stableIterations,
      ),
      collisionRampIterations: Number(
        spec.graph?.forceCollisionRampIterations ??
          globalStyle.graph?.forceCollisionRampIterations ??
          DEFAULT_FORCE_LAYOUT.collisionRampIterations,
      ),
    },
  };

  // --- text measuring (for sizing nodes to their labels) ----------------------
  const NODE_FONT = "14px sans-serif";
  const TITLE_FONT = "bold 22px sans-serif";
  const measureCanvas = createCanvas(10, 10);
  const measureCtx = measureCanvas.getContext("2d");
  measureCtx.font = NODE_FONT;
  function textWidth(s: string): number {
    return measureCtx.measureText(s).width;
  }

  // --- build node list --------------------------------------------------------
  const idToIndex: Record<string, number> = {};
  const nodes: any[] = spec.nodes.map((n: any, i: number) => {
    const style = styleFor(n.shape);
    const label = n.label ?? n.id;
    const width = Math.max(
      style.minWidth || 100,
      Math.ceil(textWidth(label)) + 28,
    );
    const height = style.minHeight || 60;
    idToIndex[n.id] = i;
    return {
      id: n.id,
      label,
      shape: n.shape,
      boundaryParent: n.parent ?? null,
      width,
      height,
      // deterministic-ish seed spread so the solver doesn't start degenerate
      x: 200 + (i % 6) * 130 + (i % 3) * 15,
      y: 150 + Math.floor(i / 6) * 130 + (i % 2) * 15,
    };
  });

  // --- build groups from boundaries -------------------------------------------
  const boundaries: any[] = spec.boundaries || [];
  const boundaryIdToGroupIndex: Record<string, number> = {};
  boundaries.forEach((b, gi) => (boundaryIdToGroupIndex[b.id] = gi));

  const boundariesById = Object.fromEntries(boundaries.map((x) => [x.id, x]));
  function boundaryDepth(b: any): number {
    let depth = 0;
    let cur = b;
    while (cur && cur.parent && boundariesById[cur.parent]) {
      depth++;
      cur = boundariesById[cur.parent];
    }
    return depth;
  }
  const maxDepth = boundaries.reduce(
    (m, b) => Math.max(m, boundaryDepth(b)),
    0,
  );
  const BASE_PAD = graphMeta.boundaryPad; // clear gap between a boundary's nodes and its border
  const LABEL_BAND = graphMeta.labelBand; // extra top room so the boundary label never touches nodes
  const NEST_PAD = graphMeta.nestPad; // extra padding per nesting level (parent label clears nested border)
  function paddingFor(b: any): number {
    // outer boundaries get more padding so nested ones sit visibly inside
    return BASE_PAD + NEST_PAD * (maxDepth - boundaryDepth(b));
  }

  const groups: any[] = boundaries.map((b) => ({
    id: b.id,
    label: b.label,
    leaves: [],
    groups: [],
    // Pad the solver's group rect by the full rendered extent (side padding plus
    // the top label band) so WebCola keeps non-member nodes outside the box we
    // actually draw, not just outside the raw node cluster. Non-drawn `group`s
    // reserve no visual padding at all: they draw no border or label, so the only
    // spacing they need is what node inflation (nodeGap) already provides. Giving
    // them the full paddingFor (which includes nestPad scaled by the deepest
    // boundary anywhere in the graph) would wrap invisible whitespace around
    // their members and fling sibling groups far apart.
    padding: b.draw === false ? 0 : paddingFor(b) + LABEL_BAND,
  }));

  nodes.forEach((n, i) => {
    if (
      n.boundaryParent != null &&
      boundaryIdToGroupIndex[n.boundaryParent] != null
    ) {
      groups[boundaryIdToGroupIndex[n.boundaryParent]].leaves.push(i);
    }
  });
  boundaries.forEach((b, gi) => {
    if (b.parent != null && boundaryIdToGroupIndex[b.parent] != null) {
      groups[boundaryIdToGroupIndex[b.parent]].groups.push(gi);
    }
  });

  // --- build links ------------------------------------------------------------
  const links: any[] = [];
  const nearPairs: any[] = [];
  for (const e of prepareEdges(
    spec.edges || [],
    String(graphMeta.labelFormat),
  )) {
    const s = idToIndex[e.source];
    const t = idToIndex[e.target];
    if (s == null || t == null || s === t) {
      console.warn(`[edge] skipping invalid edge: ${e.source} -> ${e.target}`);
      continue;
    }
    links.push({
      source: s,
      target: t,
      _sourceId: nodes[s].id,
      _targetId: nodes[t].id,
      label: e.label,
      labelWidth: e.label
        ? Math.max(
            ...e.label.split("\n").map((line: string) => textWidth(line)),
          )
        : 0,
      labelHeight: e.label ? e.label.split("\n").length * 16 : 0,
      // support DSL booleans and the legacy `type` field ("rightArrow"/"leftArrow"/"line")
      arrowSource: e.arrowSource,
      arrowTarget: e.arrowTarget,
      lineStyle: e.lineStyle,
    });
  }

  // --- translate constraints --------------------------------------------------
  function halfExtent(node: any, axis: string): number {
    return axis === "x" ? node.width / 2 : node.height / 2;
  }

  // All leaf-node indices that belong (directly or via nesting) to a boundary.
  function boundaryMembers(bid: string): number[] {
    const res: number[] = [];
    nodes.forEach((n, i) => {
      let p = n.boundaryParent;
      while (p) {
        if (p === bid) {
          res.push(i);
          break;
        }
        p = boundariesById[p]?.parent ?? null;
      }
    });
    return res;
  }

  // Resolve an id to the node indices it stands for: a plain node -> itself, a
  // boundary -> all of its member nodes. Returns null for unknown ids.
  function membersOf(id: string): number[] | null {
    if (idToIndex[id] != null) return [idToIndex[id]];
    if (boundaryIdToGroupIndex[id] != null) return boundaryMembers(id);
    return null;
  }

  // separation: on the given axis, force everything in aId before everything in
  // bId. When aId/bId are boundaries this expands to constraints between every
  // member pair, so a whole group is ordered relative to another group or node.
  // (WebCola's separation constraints are node-indexed only; groups themselves
  // get automatic containment/non-overlap but no user ordering API, so we expand
  // group rules into member-level constraints here.)
  function sep(axis: string, aId: string, bId: string, out: any[]): void {
    const A = membersOf(aId);
    const B = membersOf(bId);
    if (!A || !B || A.length === 0 || B.length === 0) {
      console.warn(
        `[constraint] skipping rule with unknown node/boundary: ${aId} / ${bId}`,
      );
      return;
    }
    for (const ai of A) {
      for (const bi of B) {
        const gap =
          halfExtent(nodes[ai], axis) +
          halfExtent(nodes[bi], axis) +
          graphMeta.minGap;
        out.push({ type: "separation", axis, left: ai, right: bi, gap });
      }
    }
  }

  const colaConstraints: any[] = [];
  for (const rule of spec.constraints || []) {
    const type = rule.type;
    // accept both the DSL { type, a, b } and legacy { type, left/right/top/bottom }
    const A = rule.a ?? rule.left ?? rule.top;
    const B = rule.b ?? rule.right ?? rule.bottom;
    switch (type) {
      case "left":
        sep("x", A, B, colaConstraints);
        break;
      case "right":
        sep("x", B, A, colaConstraints);
        break;
      case "top":
        sep("y", A, B, colaConstraints);
        break;
      case "bottom":
        sep("y", B, A, colaConstraints);
        break;
      case "topleft":
        sep("y", A, B, colaConstraints);
        sep("x", A, B, colaConstraints);
        break;
      case "topright":
        sep("y", A, B, colaConstraints);
        sep("x", B, A, colaConstraints);
        break;
      case "bottomleft":
        sep("y", B, A, colaConstraints);
        sep("x", A, B, colaConstraints);
        break;
      case "bottomright":
        sep("y", B, A, colaConstraints);
        sep("x", B, A, colaConstraints);
        break;
      case "near": {
        const A2 = membersOf(A);
        const B2 = membersOf(B);
        if (A2 && B2 && A2.length && B2.length) {
          for (const ai of A2)
            for (const bi of B2) nearPairs.push({ source: ai, target: bi });
        } else
          console.warn(
            `[constraint] skipping near with unknown node/boundary: ${A} / ${B}`,
          );
        break;
      }
      case "align": {
        // Align nodes on a shared line: WebCola axis "x" => same x (a vertical
        // line), axis "y" => same y (a horizontal line). Ids may be nodes or
        // boundaries/groups (expanded to their members).
        const idxs: number[] = [];
        let ok = true;
        for (const id of rule.ids || []) {
          const m = membersOf(id);
          if (!m || m.length === 0) {
            console.warn(`[constraint] skipping align with unknown id: ${id}`);
            ok = false;
            break;
          }
          idxs.push(...m);
        }
        if (ok && idxs.length >= 2) {
          colaConstraints.push({
            type: "alignment",
            axis: rule.axis,
            offsets: idxs.map((node) => ({ node, offset: 0 })),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // "near" is modelled as an extra short attractive link in the Cola engine.
  const layoutLinks = links.concat(nearPairs);

  // Flat target edge length. We deliberately do NOT use symmetricDiff/jaccard
  // link lengths: those scale ideal length by neighbourhood difference, which
  // stretches edges around high-degree hubs and flings their neighbours away.
  // Labelled edges get a longer ideal length so their label has room to fit.
  function linkDistanceFor(l: any): number {
    if (l.label) {
      const lines = l.label.split("\n");
      const w = Math.max(...lines.map((s: string) => textWidth(s)));
      // Multi-line labels also need vertical room, so a mostly-vertical edge is
      // long enough for a tall label chip (~16px per line plus padding).
      const h = lines.length * 16;
      return Math.max(
        graphMeta.linkLength,
        Math.ceil(w) + 60,
        Math.ceil(h) + 60,
      );
    }
    return graphMeta.linkLength;
  }

  // --- run the solver ---------------------------------------------------------
  const layout = new cola.Layout()
    .nodes(nodes)
    .links(layoutLinks)
    .groups(groups)
    .constraints(colaConstraints)
    .avoidOverlaps(true)
    // Keep the disconnected-component packing from repositioning nodes after the
    // group-containment constraints have been solved (it ignores groups and would
    // drop edgeless nodes on top of boundaries).
    .handleDisconnected(false)
    .linkDistance(linkDistanceFor);

  // keepRunning=false => run the iteration counts synchronously and stop.
  // No browser/timer loop needed, which matters for one-shot CLI/Docker runs.
  //
  // We run a short user-constraint phase (i2) so separation constraints are
  // satisfied even when they would otherwise fight overlap avoidance, then the
  // main all-constraints phase (i3). We skip the grouped warm-up (i1): it lays
  // groups out as coarse super-nodes and, for a node wired deep into a group
  // (e.g. externalEntity -> ASRV), settles into a local minimum that flings that
  // node far away. Overridable via GRAPHGEN_ITERS=a,b,c.
  //
  // WebCola's avoidOverlaps keeps node rectangles from overlapping but lets them
  // touch (zero gap). To enforce a minimum clearance we inflate every node by
  // nodeGap for the duration of the solve, then restore the true render size.
  let constraintGroupRects: Map<string, any> | null = null;
  const edgeRouting: EdgeRouting =
    graphMeta.layout === "curved" || graphMeta.layout === "orthogonal"
      ? graphMeta.layout
      : "straight";
  // A WebCola run used as a seed for the constraint engines.
  const routeClearance = Math.max(4, Math.min(12, graphMeta.nodeGap / 3));
  let afterRender: (() => void) | null = null;
  const routedMode = edgeRouting === "orthogonal" ? "orthogonal" : "curved";
  const snapOptions = {
    minGap: graphMeta.minGap,
    nodeGap: graphMeta.nodeGap,
    boundaryPad: graphMeta.boundaryPad,
    labelBand: graphMeta.labelBand,
    nestPad: graphMeta.nestPad,
    iterations: 1,
  };
  function memberSetsById(): Map<string, Set<number>> {
    const sets = new Map<string, Set<number>>();
    const parentOf = new Map(
      boundaries.map((b: any) => [b.id, b.parent ?? null]),
    );
    nodes.forEach((n, i) => {
      let current = n.boundaryParent;
      const seen = new Set<string>();
      while (current && !seen.has(current)) {
        seen.add(current);
        if (!sets.has(current)) sets.set(current, new Set());
        sets.get(current)!.add(i);
        current = parentOf.get(current) ?? null;
      }
    });
    return sets;
  }
  // Area, drawn edge length, longest edge and crossings for node positions.
  // groupRects === null measures a plain straight-line (Cola-style) drawing.
  function routedScore(
    positions: Array<{ x: number; y: number }>,
    groupRects: Map<string, any> | null,
    reference?: { area: number; length: number; longest: number },
  ) {
    nodes.forEach((n, i) => Object.assign(n, positions[i]));
    const members = memberSetsById();
    const rects = new Map<string, any>();
    boundaries.forEach((b: any) => {
      const set = members.get(b.id);
      if (!set || set.size === 0) return;
      if (groupRects?.get(b.id)) {
        rects.set(b.id, groupRects.get(b.id));
        return;
      }
      const pad = b.draw === false ? 0 : paddingFor(b);
      const band = b.draw === false ? 0 : LABEL_BAND;
      let r = {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
      };
      for (const i of set) {
        const n = nodes[i];
        r = {
          minX: Math.min(r.minX, n.x - n.width / 2 - pad),
          maxX: Math.max(r.maxX, n.x + n.width / 2 + pad),
          minY: Math.min(r.minY, n.y - n.height / 2 - pad - band),
          maxY: Math.max(r.maxY, n.y + n.height / 2 + pad),
        };
      }
      rects.set(b.id, r);
    });
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.width / 2);
      maxX = Math.max(maxX, n.x + n.width / 2);
      minY = Math.min(minY, n.y - n.height / 2);
      maxY = Math.max(maxY, n.y + n.height / 2);
    }
    boundaries.forEach((b: any) => {
      const r = rects.get(b.id);
      if (!r || b.draw === false) return;
      minX = Math.min(minX, r.minX);
      maxX = Math.max(maxX, r.maxX);
      minY = Math.min(minY, r.minY);
      maxY = Math.max(maxY, r.maxY);
    });
    const area = (maxX - minX) * (maxY - minY);
    const endpoint = (ref: any) =>
      idToIndex[(typeof ref === "number" ? nodes[ref] : ref).id];
    const routeInput = {
      nodes,
      edges: links.map((l) => ({
        source: endpoint(l.source),
        target: endpoint(l.target),
      })),
      groups: boundaries.flatMap((b: any) =>
        b.draw === false || !rects.get(b.id)
          ? []
          : [{ rect: rects.get(b.id), members: members.get(b.id)! }],
      ),
      clearance: routeClearance,
    };
    const routes =
      groupRects === null
        ? routeEdges(routeInput, "straight").map((route, i) => ({
            points: [
              borderPoint(nodes[routeInput.edges[i].source], route.points[1]),
              borderPoint(nodes[routeInput.edges[i].target], route.points[0]),
            ],
          }))
        : routeEdges(routeInput, edgeRouting);
    const lengths = routes.map((route) => polylineLength(route.points));
    const length = lengths.reduce((sum, value) => sum + value, 0);
    const longest = Math.max(0, ...lengths);
    let crossings = 0;
    const crossingPairs: Array<[number, number]> = [];
    routes.forEach((route, i) => {
      for (let j = i + 1; j < routes.length; j++) {
        const count = polylineCrossings(route.points, routes[j].points);
        if (count > 0) {
          crossings += count;
          crossingPairs.push([i, j]);
        }
      }
    });
    const hitEdges =
      groupRects === null ? [] : obstacleHits(routeInput, routes);
    const hits = hitEdges.length;
    const penalty = (crossings + hits) * 10;
    const value = reference
      ? Math.max(
          area / reference.area,
          length / Math.max(reference.length, 1),
          longest / Math.max(reference.longest, 1),
        ) +
        (area / reference.area +
          length / Math.max(reference.length, 1) +
          longest / Math.max(reference.longest, 1)) /
          100 +
        // A crossing or an edge through a node outweighs any size difference.
        penalty
      : 0;
    return {
      area,
      length,
      longest,
      crossings,
      value,
      crossingPairs,
      edges: routeInput.edges,
      hitEdges,
      lengths,
      // Score ignoring crossings/obstacle hits: what the layout could reach
      // if untangling removes them.
      potential: value - penalty,
    };
  }
  // Pulls the two ends of a long edge together: one endpoint is snapped level
  // with the other (same y) or in line with it (same x), dragging along the
  // nodes the directional rules tie to it. Compaction keeps the relative order
  // of overlapping nodes, so it can never make such a jump on its own (e.g.
  // moving a node past its column neighbour to sit beside its partner).
  function snapLongEdges(
    start: LayoutCandidate,
    reference: { area: number; length: number; longest: number },
    repair: () => ReturnType<typeof solveLayout>,
    constraints: any[] = spec.constraints || [],
  ): LayoutCandidate {
    let current = start;
    let score = routedScore(
      current.positions,
      current.result.groups,
      reference,
    );
    for (let round = 0; round < SNAP_ROUNDS[routedMode]; round++) {
      // The longest edges relative to their straight centre distance (detours)
      // and in absolute length.
      const edgeOrder = score.lengths
        .map((length, index) => ({ index, length }))
        .sort((a, b) => b.length - a.length)
        .slice(0, SNAP_EDGES[routedMode]);
      let improved: { candidate: LayoutCandidate; score: typeof score } | null =
        null;
      // Snaps that would win but for a crossing get one untangle attempt.
      const tangled: Array<{
        candidate: LayoutCandidate;
        score: typeof score;
      }> = [];
      for (const { index } of edgeOrder) {
        const edge = score.edges[index];
        for (const [moving, anchor] of [
          [edge.source, edge.target],
          [edge.target, edge.source],
        ]) {
          for (const axis of ["y", "x"] as const) {
            nodes.forEach((n, i) => Object.assign(n, current.positions[i]));
            const delta = nodes[anchor][axis] - nodes[moving][axis];
            if (Math.abs(delta) < 1) continue;
            shiftWithDependents(
              nodes,
              boundaries,
              constraints,
              snapOptions,
              nodes[moving].id,
              axis === "x" ? delta : 0,
              axis === "y" ? delta : 0,
            );
            const solved = repair();
            if (!solved.valid) continue;
            const candidate = captureCandidate(nodes, links, solved);
            const candidateScore = routedScore(
              candidate.positions,
              solved.groups,
              reference,
            );
            if (
              candidateScore.value <
              (improved?.score.value ?? score.value) - 1e-3
            ) {
              improved = { candidate, score: candidateScore };
            } else if (candidateScore.potential < score.value - 1e-3) {
              tangled.push({ candidate, score: candidateScore });
            }
          }
        }
      }
      tangled.sort((a, b) => a.score.potential - b.score.potential);
      for (const option of tangled.slice(0, SNAP_UNTANGLE_TRIES)) {
        if (improved && option.score.potential >= improved.score.value) break;
        const untangled = untangle(option.candidate, reference, repair);
        const untangledScore = routedScore(
          untangled.positions,
          untangled.result.groups,
          reference,
        );
        if (
          untangledScore.value <
          (improved?.score.value ?? score.value) - 1e-3
        ) {
          improved = { candidate: untangled, score: untangledScore };
        }
      }
      if (!improved) break;
      current = improved.candidate;
      score = improved.score;
    }
    restoreCandidate(nodes, links, current);
    return current;
  }
  // Crossings (and edges through nodes) a single curve can't avoid are removed
  // by moving an endpoint of an affected edge a step aside, repairing the
  // layout and routing again. A move is kept when it removes problems without
  // a worse score.
  function untangle(
    start: LayoutCandidate,
    reference: { area: number; length: number; longest: number },
    repair: () => ReturnType<typeof solveLayout>,
  ): LayoutCandidate {
    let current = start;
    let score = routedScore(
      current.positions,
      current.result.groups,
      reference,
    );
    const problems = (sc: typeof score) => sc.crossings + sc.hitEdges.length;
    for (
      let round = 0;
      round < UNTANGLE_ROUNDS && problems(score) > 0;
      round++
    ) {
      const movers = new Set<number>();
      for (const index of [...score.crossingPairs.flat(), ...score.hitEdges]) {
        movers.add(score.edges[index].source);
        movers.add(score.edges[index].target);
      }
      let improved: { candidate: LayoutCandidate; score: typeof score } | null =
        null;
      // A single step first; the larger one only if that finds nothing.
      for (const step of [1, 2]) {
        if (improved) break;
        for (const index of movers) {
          const node = nodes[index];
          for (const [dx, dy] of UNTANGLE_DIRECTIONS) {
            nodes.forEach((n, i) => Object.assign(n, current.positions[i]));
            node.x += dx * step * (node.width + graphMeta.nodeGap);
            node.y += dy * step * (node.height + graphMeta.nodeGap);
            const solved = repair();
            if (!solved.valid) continue;
            const candidate = captureCandidate(nodes, links, solved);
            const candidateScore = routedScore(
              candidate.positions,
              solved.groups,
              reference,
            );
            const bar = improved?.score.value ?? score.value;
            if (
              problems(candidateScore) < problems(score) &&
              candidateScore.value < bar
            ) {
              improved = { candidate, score: candidateScore };
            }
          }
        }
      }
      if (!improved) break;
      current = improved.candidate;
      score = improved.score;
    }
    restoreCandidate(nodes, links, current);
    return current;
  }
  // Warns about directional rules that stop the layout from getting much
  // smaller: each rule pressing against its limit is dropped in turn, the
  // layout is re-solved from the final positions (including long-edge
  // snapping), and rules whose removal shrinks area or edge length by at least
  // CONSTRAINT_HINT_GAIN without making anything else worse are reported.
  function warnBlockingConstraints(
    best: LayoutCandidate,
    reference: { area: number; length: number; longest: number },
    options: Parameters<typeof solveLayout>[4],
  ): void {
    const all: any[] = spec.constraints || [];
    const final = routedScore(best.positions, best.result.groups, reference);
    const hints: Array<{ rule: any; area: number; length: number }> = [];
    // Only rules on an endpoint of one of the longest edges (or a boundary
    // holding one) can be what keeps that edge from getting shorter.
    const endpoints = new Set<string>();
    final.lengths
      .map((length, index) => ({ length, index }))
      .sort((a, b) => b.length - a.length)
      .slice(0, SNAP_EDGES.curved)
      .forEach(({ index }) => {
        for (const end of [
          final.edges[index].source,
          final.edges[index].target,
        ]) {
          let id: string | null = nodes[end].id;
          while (id) {
            endpoints.add(id);
            id =
              nodes[end].id === id
                ? nodes[end].boundaryParent
                : (boundaries.find((b: any) => b.id === id)?.parent ?? null);
          }
        }
      });
    for (const rule of all) {
      if (rule.type === "align" || rule.type === "near") continue;
      if (!endpoints.has(rule.a) && !endpoints.has(rule.b)) continue;
      nodes.forEach((n, i) => Object.assign(n, best.positions[i]));
      const slack = directionalSlack(nodes, boundaries, rule, options);
      if (slack === null || slack > CONSTRAINT_HINT_SLACK) continue;
      const others = all.filter((other) => other !== rule);
      const repair = () =>
        solveLayout(nodes, boundaries, links, others, options);
      const solved = repair();
      if (!solved.valid) continue;
      const relaxed = snapLongEdges(
        captureCandidate(nodes, links, solved),
        reference,
        repair,
        others,
      );
      const score = routedScore(
        relaxed.positions,
        relaxed.result.groups,
        reference,
      );
      if (score.crossings + score.hitEdges.length > 0) continue;
      const area = 1 - score.area / final.area;
      const length = 1 - score.length / final.length;
      const longest = 1 - score.longest / final.longest;
      const noWorse = Math.min(area, length, longest) > -0.02;
      if (noWorse && Math.max(area, length) >= CONSTRAINT_HINT_GAIN) {
        hints.push({ rule, area, length });
      }
    }
    restoreCandidate(nodes, links, best);
    hints
      .sort((a, b) => b.area + b.length - (a.area + a.length))
      .slice(0, 3)
      .forEach(({ rule, area, length }) => {
        const where = rule.sourceFile
          ? `${path.relative(process.cwd(), rule.sourceFile)}:${rule.line}`
          : `line ${rule.line}`;
        const gains = [
          area >= 0.01 && `${Math.round(area * 100)}% smaller`,
          length >= 0.01 && `edges ${Math.round(length * 100)}% shorter`,
        ].filter(Boolean);
        console.warn(
          `[constraint] ${where}: "${rule.a} ${rule.type} ${rule.b}" blocks a better layout of this graph (without it: ${gains.join(", ")}); run "npm run improve-rules" to check the graphs that share it`,
        );
      });
  }
  // Nodes without edges are moved into free space once the layout is final.
  // Kept only when routing the result is no worse.
  function placeEdgeless(
    start: LayoutCandidate,
    reference: { area: number; length: number; longest: number },
    options: Parameters<typeof solveLayout>[4],
    repair: () => ReturnType<typeof solveLayout>,
  ): LayoutCandidate {
    restoreCandidate(nodes, links, start);
    const groups = placeEdgelessAndCompact(
      nodes,
      boundaries,
      links,
      spec.constraints || [],
      options,
    );
    if (!groups) return start;
    let candidate = captureCandidate(nodes, links, {
      ...start.result,
      groups,
    });
    const before = routedScore(start.positions, start.result.groups, reference);
    let after = routedScore(candidate.positions, groups, reference);
    // Compacting into the freed space can make edges cross; try to untangle
    // those before giving up on the smaller layout.
    if (after.crossings + after.hitEdges.length > 0) {
      candidate = untangle(candidate, reference, repair);
      after = routedScore(
        candidate.positions,
        candidate.result.groups,
        reference,
      );
    }
    const kept =
      after.crossings + after.hitEdges.length <=
        before.crossings + before.hitEdges.length &&
      after.value <= before.value + 1e-9;
    restoreCandidate(nodes, links, kept ? candidate : start);
    return kept ? candidate : start;
  }
  function borderPoint(node: any, toward: { x: number; y: number }) {
    const dx = toward.x - node.x;
    const dy = toward.y - node.y;
    if (dx === 0 && dy === 0) return { x: node.x, y: node.y };
    const scale = Math.min(
      dx !== 0 ? node.width / 2 / Math.abs(dx) : Infinity,
      dy !== 0 ? node.height / 2 / Math.abs(dy) : Infinity,
    );
    return { x: node.x + dx * scale, y: node.y + dy * scale };
  }
  function runStressLayout(linkScale = 1, warmStart = false): void {
    for (const n of nodes) {
      n.width += graphMeta.nodeGap;
      n.height += graphMeta.nodeGap;
    }
    if (linkScale !== 1) {
      layout.linkDistance((l: any) => linkDistanceFor(l) * linkScale);
    }
    const [userIterations, allIterations] = warmStart
      ? STRESS_SEED_ITERATIONS.warm
      : STRESS_SEED_ITERATIONS[
          edgeRouting === "straight" ? "straight" : "routed"
        ];
    layout.start(0, userIterations, allIterations, 0, false);
    if (linkScale !== 1) layout.linkDistance(linkDistanceFor);
    for (const n of nodes) {
      n.width -= graphMeta.nodeGap;
      n.height -= graphMeta.nodeGap;
    }
  }
  const layoutStart = performance.now();
  if (
    graphMeta.layout === "constraint" ||
    graphMeta.layout === "force" ||
    edgeRouting !== "straight"
  ) {
    let forceSnapshots: LayoutSnapshot[] = [];
    if (graphMeta.layout === "force") {
      forceSnapshots = applyForceLayout(nodes, boundaries, links, {
        iterations: Number.isFinite(graphMeta.layoutIterations)
          ? Math.max(1, Math.floor(graphMeta.layoutIterations))
          : 1000,
        nodeGap: graphMeta.nodeGap * graphMeta.forceNodeGapMultiplier,
        linkLength: graphMeta.linkLength,
        debugFrameEvery: Number.isFinite(graphMeta.forceDebugFrameEvery)
          ? Math.max(0, Math.floor(graphMeta.forceDebugFrameEvery))
          : 0,
        ...graphMeta.force,
      });
    }
    const solveOptions = (
      preserveInitialPositions: boolean,
      compactCenterPull?: number,
    ) => ({
      minGap: graphMeta.minGap,
      nodeGap: graphMeta.nodeGap,
      boundaryPad: graphMeta.boundaryPad,
      labelBand: graphMeta.labelBand,
      nestPad: graphMeta.nestPad,
      iterations: Number.isFinite(graphMeta.layoutIterations)
        ? Math.max(1, Math.floor(graphMeta.layoutIterations))
        : 1000,
      debugFrameEvery: Number.isFinite(graphMeta.debugFrameEvery)
        ? Math.max(0, Math.floor(graphMeta.debugFrameEvery))
        : 0,
      minimizeIterations: Number.isFinite(graphMeta.minimize)
        ? Math.max(0, Math.floor(graphMeta.minimize))
        : 100,
      preserveInitialPositions,
      edgeRouting,
      fastCompaction: edgeRouting !== "straight",
      compactCenterPull,
    });
    const seedPositions = nodes.map((n) => ({ x: n.x, y: n.y }));
    // Stress (WebCola) seeds are cached: the run is the expensive part.
    const stressSeeds = new Map<number, Array<{ x: number; y: number }>>();
    const stressSeed = (linkScale: number) => {
      if (!stressSeeds.has(linkScale)) {
        // Variants warm-start from the plain stress layout, which needs far
        // fewer iterations than starting from scratch.
        const start = linkScale === 1 ? seedPositions : stressSeed(1);
        nodes.forEach((n, i) => Object.assign(n, start[i]));
        runStressLayout(linkScale, linkScale !== 1);
        stressSeeds.set(
          linkScale,
          nodes.map((n) => ({ x: n.x, y: n.y })),
        );
      }
      return stressSeeds.get(linkScale)!;
    };
    // Optional extra start from a previous layout dump (GRAPHGEN_WARM_START),
    // e.g. the same graph before a rule was removed: that layout is still
    // allowed, so including it means the result can't get worse.
    const warmStart: Array<{ x: number; y: number }> | null = (() => {
      const file = process.env.GRAPHGEN_WARM_START;
      if (!file || !fs.existsSync(file)) return null;
      const dump = JSON.parse(fs.readFileSync(file, "utf8"));
      const byId = new Map<string, any>(dump.nodes.map((n: any) => [n.id, n]));
      if (!nodes.every((n) => byId.has(n.id))) return null;
      return nodes.map((n) => ({ x: byId.get(n.id).x, y: byId.get(n.id).y }));
    })();
    const solveFrom = (
      seed: "grid" | "stress" | "force" | "warm",
      variant: { linkScale?: number; centerPull?: number } = {},
    ) => {
      if (seed === "stress") {
        const positions = stressSeed(variant.linkScale ?? 1);
        nodes.forEach((n, i) => Object.assign(n, positions[i]));
      } else if (seed === "grid") {
        nodes.forEach((n, i) => Object.assign(n, seedPositions[i]));
      } else if (seed === "warm" && warmStart) {
        nodes.forEach((n, i) => Object.assign(n, warmStart[i]));
      }
      const solved = solveLayout(
        nodes,
        boundaries,
        links,
        spec.constraints || [],
        solveOptions(seed !== "grid", variant.centerPull),
      );
      return captureCandidate(nodes, links, solved);
    };
    let best: LayoutCandidate;
    if (graphMeta.layout === "force") {
      best = solveFrom("force");
      if (!best.result.valid) {
        console.warn(
          `[force] repair did not converge; falling back to the constraint grid seed: ${best.result.violations.slice(0, 3).join("; ")}`,
        );
        best = solveFrom("grid");
      }
    } else {
      // Multi-start: the grid seed can trap the local search in a poor basin,
      // while a stress (Cola-style) seed has a good global arrangement but may
      // not repair into a valid layout. Routed engines only need the latter.
      if (edgeRouting === "straight") {
        best = pickBetterCandidate(solveFrom("grid"), solveFrom("stress"));
        if (warmStart) best = pickBetterCandidate(best, solveFrom("warm"));
      } else {
        // Routed engines are cheap enough to try several starts. They are
        // scored after routing against the plain WebCola layout (the stress
        // seed itself), minimising the worst of area / edge length / longest
        // edge relative to it.
        const reference = routedScore(stressSeed(1), null);
        const variants: Array<
          [
            "grid" | "stress" | "warm",
            { linkScale?: number; centerPull?: number },
          ]
        > = [
          ["stress", {}],
          ["stress", { centerPull: 2 }],
          ["stress", { linkScale: 0.6 }],
          ["grid", {}],
          ...(warmStart
            ? [["warm", {}] as ["warm", { centerPull?: number }]]
            : []),
        ];
        let bestScore = Infinity;
        best = solveFrom("stress");
        for (const [seed, variant] of variants) {
          const candidate =
            seed === "stress" && Object.keys(variant).length === 0
              ? best
              : solveFrom(seed, variant);
          if (!candidate.result.valid) continue;
          restoreCandidate(nodes, links, candidate);
          const score = routedScore(
            candidate.positions,
            candidate.result.groups,
            reference,
          );
          if (score.value < bestScore) {
            bestScore = score.value;
            best = candidate;
          }
        }
        const repair = () =>
          solveLayout(
            nodes,
            boundaries,
            links,
            spec.constraints || [],
            solveOptions(true),
          );
        best = snapLongEdges(best, reference, repair);
        best = untangle(best, reference, repair);
        best = placeEdgeless(best, reference, solveOptions(true), repair);
        if (graphMeta.constraintHints) {
          // Runs after the PNG is written so it never delays the image.
          const chosen = best;
          const hintOptions = solveOptions(true);
          afterRender = () =>
            warnBlockingConstraints(chosen, reference, hintOptions);
        }
      }
    }
    restoreCandidate(nodes, links, best);
    const result = best.result;
    constraintGroupRects = result.groups;
    await writeDebugFrames(
      [...forceSnapshots, ...result.snapshots],
      outputPath,
      links,
    );
    if (!result.valid) {
      const details = result.violations.slice(0, 8).join("; ");
      throw new Error(
        `constraint layout did not converge after ${result.iterations} iterations: ${details}`,
      );
    }
  } else if (graphMeta.layout === "cola") {
    const GAP = graphMeta.nodeGap;
    for (const n of nodes) {
      n.width += GAP;
      n.height += GAP;
    }
    const styleIters =
      Array.isArray(graphMeta.iterations) &&
      graphMeta.iterations.length === 3 &&
      graphMeta.iterations.every(Number.isFinite)
        ? graphMeta.iterations
        : [0, 100, 1000];
    const envIters = (process.env.GRAPHGEN_ITERS || "").split(",").map(Number);
    const [i1, i2, i3] =
      envIters.length === 3 && envIters.every(Number.isFinite)
        ? envIters
        : styleIters;
    layout.start(i1, i2, i3, 0, false);
    for (const n of nodes) {
      n.width -= GAP;
      n.height -= GAP;
    }
  } else {
    throw new Error(
      `unknown graph.layout ${JSON.stringify(graphMeta.layout)}; expected "constraint", "curved", "orthogonal", "force", or "cola"`,
    );
  }

  // Alignment constraints are equalities the solver may fail to satisfy when they
  // fight separation/overlap rules. Warn if any aligned set didn't line up, so a
  // contradictory layout is surfaced rather than silently skewed.
  for (const c of graphMeta.layout === "cola" ? colaConstraints : []) {
    if (c.type !== "alignment") continue;
    const coords = c.offsets.map((o: any) => nodes[o.node][c.axis]);
    const spread = Math.max(...coords) - Math.min(...coords);
    if (spread > 1) {
      const ids = c.offsets.map((o: any) => nodes[o.node].id).join(", ");
      console.warn(
        `[constraint] align ${c.axis} could not be satisfied ` +
          `(off by ${spread.toFixed(1)}px): ${ids}`,
      );
    }
  }

  const layoutMs = performance.now() - layoutStart;

  // --- compute group membership ----------------------------------------------
  function descendantNodeIndices(
    gi: number,
    seen = new Set<number>(),
  ): number[] {
    if (seen.has(gi)) return [];
    seen.add(gi);
    const g = groups[gi];
    let idx = g.leaves.map((l: any) => (typeof l === "number" ? l : l.index));
    for (const cg of g.groups) {
      const cgi = typeof cg === "number" ? cg : groups.indexOf(cg);
      idx = idx.concat(descendantNodeIndices(cgi, seen));
    }
    return idx;
  }
  const memberSets = groups.map((_, gi) => new Set(descendantNodeIndices(gi)));

  // render padding (for the drawn box); the solver padding above is larger.
  function renderRect(gi: number): any {
    const pad = paddingFor(boundaries[gi]);
    const band = boundaries[gi].draw === false ? 0 : LABEL_BAND;
    let mnX = Infinity,
      mnY = Infinity,
      mxX = -Infinity,
      mxY = -Infinity;
    for (const i of memberSets[gi]) {
      const n = nodes[i];
      mnX = Math.min(mnX, n.x - n.width / 2);
      mxX = Math.max(mxX, n.x + n.width / 2);
      mnY = Math.min(mnY, n.y - n.height / 2);
      mxY = Math.max(mxY, n.y + n.height / 2);
    }
    if (!isFinite(mnX)) return null;
    return {
      minX: mnX - pad,
      maxX: mxX + pad,
      minY: mnY - pad - band,
      maxY: mxY + pad,
    };
  }

  // --- compute group rects for rendering --------------------------------------
  // WebCola's native hierarchical grouping (with handleDisconnected(false)) keeps
  // disjoint groups from overlapping and nested groups contained, so no manual
  // separation pass is needed; we just draw a box around each group's members.
  groups.forEach((g, gi) => {
    g._rect = constraintGroupRects?.get(boundaries[gi].id) ?? renderRect(gi);
  });

  // --- route edges around obstacles (curved / orthogonal engines) -------------
  function resolveNode(ref: any): any {
    return typeof ref === "number" ? nodes[ref] : ref;
  }
  if (edgeRouting !== "straight") {
    const routeInput = {
      nodes,
      edges: links.map((link) => ({
        source: idToIndex[resolveNode(link.source).id],
        target: idToIndex[resolveNode(link.target).id],
        labelWidth: link.label ? link.labelWidth : 0,
        labelHeight: link.label ? link.labelHeight : 0,
      })),
      groups: groups.flatMap((g, gi) =>
        boundaries[gi].draw === false || !g._rect
          ? []
          : [{ rect: g._rect, members: memberSets[gi] }],
      ),
      clearance: routeClearance,
    };
    const routes = routeEdges(routeInput, edgeRouting);
    const spots = placeRouteLabels(routeInput, routes);
    links.forEach((link, i) => {
      link.route = routes[i];
      const spot = spots[i];
      if (spot) {
        link.labelX = spot.x;
        link.labelY = spot.y;
        link.labelAnchorX = spot.anchorX;
        link.labelAnchorY = spot.anchorY;
      }
    });
  }

  // --- compute canvas bounds --------------------------------------------------
  const MARGIN = 60;
  const TITLE_SPACE = graphMeta.title ? 44 : 0;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.width / 2);
    maxX = Math.max(maxX, n.x + n.width / 2);
    minY = Math.min(minY, n.y - n.height / 2);
    maxY = Math.max(maxY, n.y + n.height / 2);
  }
  for (const g of groups) {
    if (!g._rect) continue;
    if (boundaries[groups.indexOf(g)].draw === false) continue; // non-drawn groups add no margin
    minX = Math.min(minX, g._rect.minX);
    maxX = Math.max(maxX, g._rect.maxX);
    minY = Math.min(minY, g._rect.minY);
    maxY = Math.max(maxY, g._rect.maxY);
  }
  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 100;
    maxY = 100;
  }

  const width = maxX - minX + MARGIN * 2;
  const height = maxY - minY + MARGIN * 2 + TITLE_SPACE;
  const offsetX = -minX + MARGIN;
  const offsetY = -minY + MARGIN + TITLE_SPACE;

  function tx(x: number): number {
    return x + offsetX;
  }
  function ty(y: number): number {
    return y + offsetY;
  }

  // --- render -----------------------------------------------------------------
  const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (graphMeta.title) {
    ctx.font = TITLE_FONT;
    ctx.fillStyle = "#111111";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(graphMeta.title, canvas.width / 2, 16);
  }

  ctx.font = NODE_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  function roundRectPath(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, rad);
    } else {
      // manual fallback for canvas builds without roundRect
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + w, y, x + w, y + h, rad);
      ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad);
      ctx.arcTo(x, y, x + w, y, rad);
      ctx.closePath();
    }
  }

  // -- boundaries (drawn first, behind everything, outermost first) --
  for (let d = 0; d <= maxDepth; d++) {
    boundaries.forEach((b, gi) => {
      if (boundaryDepth(b) !== d) return;
      if (b.draw === false) return; // `group`s participate in layout but aren't drawn
      const g = groups[gi];
      if (!g._rect) return;
      const style = styleFor(b.shape || "boundary");
      const x = tx(g._rect.minX);
      const y = ty(g._rect.minY);
      const w = g._rect.maxX - g._rect.minX;
      const h = g._rect.maxY - g._rect.minY;

      ctx.save();
      if (style.lineStyle === "dashed") ctx.setLineDash([8, 5]);
      roundRectPath(x, y, w, h, style.borderRadius ?? 10);
      if (style.color && style.color !== "transparent") {
        ctx.fillStyle = style.color;
        ctx.fill();
      }
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = style.borderColor || "#888888";
      ctx.stroke();
      ctx.restore();

      if (b.label) {
        ctx.save();
        ctx.font = "italic 13px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillStyle = "#666666";
        ctx.fillText(b.label, x + 8, y + 6);
        ctx.restore();
      }
    });
  }

  // -- edge geometry helpers --
  // intersection of the segment (center -> toward) with the node's rectangle
  function boundaryPoint(node: any, towardX: number, towardY: number) {
    const cx = tx(node.x);
    const cy = ty(node.y);
    const dx = towardX - cx;
    const dy = towardY - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };

    const hw = node.width / 2;
    const hh = node.height / 2;
    const scaleX = dx !== 0 ? hw / Math.abs(dx) : Infinity;
    const scaleY = dy !== 0 ? hh / Math.abs(dy) : Infinity;
    const scale = Math.min(scaleX, scaleY);
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  function drawArrowhead(x: number, y: number, angle: number): void {
    const size = 10;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, size / 2);
    ctx.lineTo(-size, -size / 2);
    ctx.closePath();
    ctx.fillStyle = graphMeta.lineColor;
    ctx.fill();
    ctx.restore();
  }

  // -- stickman rendering for `actor` shapes --
  function drawStickman(
    cx: number,
    cy: number,
    w: number,
    h: number,
    color: string,
    label: string,
  ): void {
    const labelH = 18;
    const figH = h - labelH;
    const topY = cy - h / 2;
    const headR = Math.min(figH * 0.16, w * 0.22);
    const headCy = topY + headR + 2;
    const neckY = headCy + headR;
    const shoulderY = topY + figH * 0.42;
    const hipY = topY + figH * 0.62;
    const footY = topY + figH;
    const armSpan = Math.min(figH * 0.3, w * 0.42);
    const legSpread = Math.min(figH * 0.22, w * 0.35);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    // head
    ctx.beginPath();
    ctx.fillStyle = "#ffffff";
    ctx.arc(cx, headCy, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // body + arms + legs
    ctx.beginPath();
    ctx.moveTo(cx, neckY);
    ctx.lineTo(cx, hipY);
    ctx.moveTo(cx - armSpan, shoulderY);
    ctx.lineTo(cx + armSpan, shoulderY);
    ctx.moveTo(cx, hipY);
    ctx.lineTo(cx - legSpread, footY);
    ctx.moveTo(cx, hipY);
    ctx.lineTo(cx + legSpread, footY);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = "#111111";
    ctx.fillText(label, cx, cy + h / 2 - labelH / 2 + 2);
  }

  // -- 3D cylinder rendering for `database` shapes --
  function drawCylinder(
    cx: number,
    cy: number,
    w: number,
    h: number,
    style: any,
    label: string,
  ): void {
    const rx = w / 2;
    const ry = Math.min(h * 0.16, rx * 0.45); // vertical radius of the lid/base
    const topY = cy - h / 2 + ry; // centre y of the top ellipse
    const botY = cy + h / 2 - ry; // centre y of the bottom ellipse
    const hasFill = style.color && style.color !== "transparent";

    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = style.borderColor || "#3355aa";

    if (hasFill) {
      ctx.fillStyle = style.color;
      ctx.fillRect(cx - rx, topY, w, botY - topY);
      ctx.beginPath();
      ctx.ellipse(cx, botY, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx, topY, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // sides + front (bottom) arc
    ctx.beginPath();
    ctx.moveTo(cx - rx, topY);
    ctx.lineTo(cx - rx, botY);
    ctx.ellipse(cx, botY, rx, ry, 0, Math.PI, 0, true); // bottom front arc
    ctx.lineTo(cx + rx, topY);
    ctx.stroke();

    // top lid (full ellipse)
    ctx.beginPath();
    ctx.ellipse(cx, topY, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();

    ctx.fillStyle = "#111111";
    ctx.fillText(label, cx, cy + ry * 0.6);
  }

  // -- edges (drawn under nodes; labels are collected and drawn last, on top) --
  // WebCola rewrites link.source/target from indices into node references during
  // start(); handle either form here.
  const edgeLabels: any[] = [];
  const drawnPaths: Array<Array<{ x: number; y: number }>> = [];
  for (const link of links) {
    const source = resolveNode(link.source);
    const target = resolveNode(link.target);
    const sc = { x: tx(source.x), y: ty(source.y) };
    const tc = { x: tx(target.x), y: ty(target.y) };

    const route: EdgeRoute | undefined = link.route;
    const toCanvas = (p: { x: number; y: number }) => ({
      x: tx(p.x),
      y: ty(p.y),
    });
    const path = route
      ? route.points.map(toCanvas)
      : [boundaryPoint(source, tc.x, tc.y), boundaryPoint(target, sc.x, sc.y)];
    const p1 = path[0];
    const p2 = path[path.length - 1];
    drawnPaths.push(path);

    ctx.save();
    ctx.strokeStyle = graphMeta.lineColor;
    ctx.lineWidth = 1.5;
    if (link.lineStyle === "dotted") ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    if (route?.curve) {
      const c = toCanvas(route.curve.c);
      ctx.quadraticCurveTo(c.x, c.y, p2.x, p2.y);
    } else {
      for (const p of path.slice(1)) ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();

    if (route) {
      // Arrowheads follow the direction the path arrives at / leaves each end.
      const control = route.curve ? toCanvas(route.curve.c) : null;
      const beforeEnd = control ?? path[path.length - 2];
      const afterStart = control ?? path[1];
      if (link.arrowTarget) {
        drawArrowhead(
          p2.x,
          p2.y,
          Math.atan2(p2.y - beforeEnd.y, p2.x - beforeEnd.x),
        );
      }
      if (link.arrowSource) {
        drawArrowhead(
          p1.x,
          p1.y,
          Math.atan2(p1.y - afterStart.y, p1.x - afterStart.x),
        );
      }
    } else {
      const angleToTarget = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      if (link.arrowTarget) drawArrowhead(p2.x, p2.y, angleToTarget);
      if (link.arrowSource) drawArrowhead(p1.x, p1.y, angleToTarget + Math.PI);
    }

    if (link.label) {
      // Labels on horizontal-ish edges are pushed below their anchor (the edge
      // midpoint) so the chip doesn't hide the line. On vertical-ish edges a
      // downward push would just slide the chip along the line without clearing
      // it, so those labels stay centred on the midpoint instead.
      const ax = (p1.x + p2.x) / 2;
      const ay = (p1.y + p2.y) / 2;
      const horizontal = Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y);
      edgeLabels.push({
        text: link.label,
        x: link.labelX == null ? ax : tx(link.labelX),
        // anchor: the true midpoint the label belongs to (before the offset)
        ax: link.labelAnchorX == null ? ax : tx(link.labelAnchorX),
        ay: link.labelAnchorY == null ? ay : ty(link.labelAnchorY),
        y: link.labelY == null ? undefined : ty(link.labelY),
        offset: link.labelY == null && horizontal,
      });
    }
  }

  // -- nodes --
  // Nodes with no visible edge are drawn at half opacity.
  const connectedIds = new Set();
  for (const link of links) {
    connectedIds.add(resolveNode(link.source).id);
    connectedIds.add(resolveNode(link.target).id);
  }
  for (const n of nodes) {
    const style = styleFor(n.shape);
    const cx = tx(n.x);
    const cy = ty(n.y);

    ctx.save();
    if (!connectedIds.has(n.id)) ctx.globalAlpha = 0.5;

    // actors render as a stickman instead of a box
    if (style.type === "actor") {
      drawStickman(
        cx,
        cy,
        n.width,
        n.height,
        style.borderColor || "#333333",
        n.label,
      );
      ctx.restore();
      continue;
    }

    // databases render as a 3D cylinder
    if (style.type === "cylinder") {
      drawCylinder(cx, cy, n.width, n.height, style, n.label);
      ctx.restore();
      continue;
    }

    const x = cx - n.width / 2;
    const y = cy - n.height / 2;

    ctx.save();
    if (style.lineStyle === "dashed") ctx.setLineDash([6, 4]);
    roundRectPath(x, y, n.width, n.height, style.borderRadius ?? 6);
    // transparent-background shapes are outline-only (fill skipped)
    if (style.color && style.color !== "transparent") {
      ctx.fillStyle = style.color;
      ctx.fill();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = style.borderColor || "#3355aa";
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = "#111111";
    ctx.fillText(n.label, cx, cy);
    ctx.restore();
  }

  // -- edge labels (drawn last so they sit on top of nodes and edges) --
  const labelRects: Array<{
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }> = [];
  for (const lbl of edgeLabels) {
    const lines = lbl.text.split("\n");
    const lineH = 16;
    const maxW = Math.max(...lines.map((l: string) => textWidth(l)));
    const totalH = lines.length * lineH;
    // Offset labels sit fully below the anchor so the chip never hides the line,
    // regardless of how many lines the label has.
    const y = lbl.y ?? (lbl.offset ? lbl.ay + totalH / 2 + 8 : lbl.ay);
    const top = y - totalH / 2;
    labelRects.push({
      minX: lbl.x - maxW / 2 - 4,
      maxX: lbl.x + maxW / 2 + 4,
      minY: top - 2,
      maxY: top + totalH + 2,
    });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(lbl.x - maxW / 2 - 4, top - 2, maxW + 8, totalH + 4);
    ctx.fillStyle = "#222222";
    lines.forEach((line: string, i: number) => {
      ctx.fillText(line, lbl.x, top + lineH / 2 + i * lineH);
    });
  }

  // --- optional debug dump (positions + group rects) for testing --------------
  if (process.env.GRAPHGEN_DUMP) {
    const dump = {
      meta: {
        nodeGap: graphMeta.nodeGap,
        minGap: graphMeta.minGap,
        layoutMs,
        layout: graphMeta.layout,
      },
      nodes: nodes.map((n) => ({
        id: n.id,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        parent: n.boundaryParent,
      })),
      groups: groups.map((g, gi) => ({
        id: g.id,
        rect: g._rect,
        parent: boundaries[gi].parent ?? null,
      })),
      // Drawn edge paths and label boxes, in layout coordinates.
      edges: links.map((l, i) => ({
        source: l._sourceId,
        target: l._targetId,
        // Curves are sampled into a polyline; their samples are not bends.
        curve: Boolean(l.route?.curve),
        points: drawnPaths[i].map((p) => ({
          x: p.x - offsetX,
          y: p.y - offsetY,
        })),
      })),
      labels: labelRects.map((r) => ({
        minX: r.minX - offsetX,
        maxX: r.maxX - offsetX,
        minY: r.minY - offsetY,
        maxY: r.maxY - offsetY,
      })),
    };
    fs.writeFileSync(process.env.GRAPHGEN_DUMP, JSON.stringify(dump, null, 2));
  }

  // --- save -------------------------------------------------------------------
  await writePng(canvas, outputPath);
  afterRender?.();

  return { width: canvas.width, height: canvas.height };
}
