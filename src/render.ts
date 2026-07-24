import fs from "node:fs";
import path from "node:path";
import * as cola from "webcola";
import { createCanvas } from "canvas";
import { stripComments, type GraphSpec } from "./parse";

export interface RenderResult {
  width: number;
  height: number;
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
      label: e.label,
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

  // "near" is modelled as an extra short attractive link
  const layoutLinks = links.concat(nearPairs);

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
    // Flat target edge length. We deliberately do NOT use symmetricDiff/jaccard
    // link lengths: those scale ideal length by neighbourhood difference, which
    // stretches edges around high-degree hubs and flings their neighbours away.
    // Labelled edges get a longer ideal length so their label has room to fit.
    .linkDistance((l: any) => {
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
    });

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

  // Alignment constraints are equalities the solver may fail to satisfy when they
  // fight separation/overlap rules. Warn if any aligned set didn't line up, so a
  // contradictory layout is surfaced rather than silently skewed.
  for (const c of colaConstraints) {
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
    g._rect = renderRect(gi);
  });

  // --- optional debug dump (positions + group rects) for testing --------------
  if (process.env.GRAPHGEN_DUMP) {
    const dump = {
      meta: { nodeGap: graphMeta.nodeGap, minGap: graphMeta.minGap },
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
    };
    fs.writeFileSync(process.env.GRAPHGEN_DUMP, JSON.stringify(dump, null, 2));
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
  function resolveNode(ref: any): any {
    return typeof ref === "number" ? nodes[ref] : ref;
  }
  const edgeLabels: any[] = [];
  for (const link of links) {
    const source = resolveNode(link.source);
    const target = resolveNode(link.target);
    const sc = { x: tx(source.x), y: ty(source.y) };
    const tc = { x: tx(target.x), y: ty(target.y) };

    const p1 = boundaryPoint(source, tc.x, tc.y);
    const p2 = boundaryPoint(target, sc.x, sc.y);

    ctx.save();
    ctx.strokeStyle = graphMeta.lineColor;
    ctx.lineWidth = 1.5;
    if (link.lineStyle === "dotted") ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    ctx.restore();

    const angleToTarget = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    if (link.arrowTarget) drawArrowhead(p2.x, p2.y, angleToTarget);
    if (link.arrowSource) drawArrowhead(p1.x, p1.y, angleToTarget + Math.PI);

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
        x: ax,
        // anchor: the true midpoint the label belongs to (before the offset)
        ax,
        ay,
        offset: horizontal,
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
  for (const lbl of edgeLabels) {
    const lines = lbl.text.split("\n");
    const lineH = 16;
    const maxW = Math.max(...lines.map((l: string) => textWidth(l)));
    const totalH = lines.length * lineH;
    // Offset labels sit fully below the anchor so the chip never hides the line,
    // regardless of how many lines the label has.
    const y = lbl.offset ? lbl.ay + totalH / 2 + 8 : lbl.ay;
    const top = y - totalH / 2;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(lbl.x - maxW / 2 - 4, top - 2, maxW + 8, totalH + 4);
    ctx.fillStyle = "#222222";
    lines.forEach((line: string, i: number) => {
      ctx.fillText(line, lbl.x, top + lineH / 2 + i * lineH);
    });
  }

  // --- save -------------------------------------------------------------------
  await writePng(canvas, outputPath);

  return { width: canvas.width, height: canvas.height };
}
