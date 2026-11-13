// routing.ts — edge routing for the "curved" and "orthogonal" layout engines.
//
// The layout keeps nodes and boundaries apart; this module then routes every
// edge around the nodes and boundaries it doesn't belong to, instead of the
// layout having to push nodes apart until straight lines fit:
//   curved      one quadratic Bézier per edge (a single bend-free curve)
//   orthogonal  axis-parallel segments joined by 90° bends (A* on a sparse grid)
// Labels are then placed beside their routed edge.

export type EdgeRouting = "straight" | "curved" | "orthogonal";

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RouteNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RouteEdge {
  source: number;
  target: number;
  labelWidth?: number;
  labelHeight?: number;
}

export interface RouteGroup {
  rect: Box;
  members: Set<number>;
}

export interface RouteInput {
  nodes: RouteNode[];
  edges: RouteEdge[];
  groups: RouteGroup[];
  clearance: number;
}

export interface EdgeRoute {
  // Visible path from the source border to the target border. Curves are
  // sampled into a polyline here; `curve` holds the exact Bézier for drawing.
  points: Pt[];
  curve?: { p0: Pt; c: Pt; p2: Pt };
}

export interface LabelSpot {
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
}

const EPS = 1e-6;

function nodeBox(node: RouteNode, pad = 0): Box {
  return {
    minX: node.x - node.width / 2 - pad,
    maxX: node.x + node.width / 2 + pad,
    minY: node.y - node.height / 2 - pad,
    maxY: node.y + node.height / 2 + pad,
  };
}

function expand(box: Box, pad: number): Box {
  return {
    minX: box.minX - pad,
    maxX: box.maxX + pad,
    minY: box.minY - pad,
    maxY: box.maxY + pad,
  };
}

function strictlyInside(p: Pt, box: Box): boolean {
  return (
    p.x > box.minX + EPS &&
    p.x < box.maxX - EPS &&
    p.y > box.minY + EPS &&
    p.y < box.maxY - EPS
  );
}

function boxesOverlap(a: Box, b: Box): boolean {
  return (
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
  );
}

export function segmentHitsBox(a: Pt, b: Pt, box: Box): boolean {
  if (
    Math.max(a.x, b.x) <= box.minX ||
    Math.min(a.x, b.x) >= box.maxX ||
    Math.max(a.y, b.y) <= box.minY ||
    Math.min(a.y, b.y) >= box.maxY
  ) {
    return false;
  }
  let low = 0;
  let high = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clips: Array<[number, number]> = [
    [-dx, a.x - box.minX],
    [dx, box.maxX - a.x],
    [-dy, a.y - box.minY],
    [dy, box.maxY - a.y],
  ];
  for (const [p, q] of clips) {
    if (Math.abs(p) < EPS) {
      if (q <= 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) low = Math.max(low, r);
    else high = Math.min(high, r);
    if (low >= high) return false;
  }
  return high - low > EPS;
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return d1 * d2 < -EPS && d3 * d4 < -EPS;
}

export function polylineLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    );
  }
  return total;
}

export function polylineCrossings(p: Pt[], q: Pt[]): number {
  let count = 0;
  for (let i = 1; i < p.length; i++) {
    for (let j = 1; j < q.length; j++) {
      if (segmentsCross(p[i - 1], p[i], q[j - 1], q[j])) count++;
    }
  }
  return count;
}

function polylineHitsBox(points: Pt[], box: Box): boolean {
  for (let i = 1; i < points.length; i++) {
    if (segmentHitsBox(points[i - 1], points[i], box)) return true;
  }
  return false;
}

function polylineBounds(points: Pt[]): Box {
  const box = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const p of points) {
    box.minX = Math.min(box.minX, p.x);
    box.maxX = Math.max(box.maxX, p.x);
    box.minY = Math.min(box.minY, p.y);
    box.maxY = Math.max(box.maxY, p.y);
  }
  return box;
}

// Obstacles an edge must avoid: every other node and every boundary that holds
// neither endpoint.
function obstaclesFor(input: RouteInput, edge: RouteEdge): Box[] {
  const boxes: Box[] = [];
  input.nodes.forEach((node, index) => {
    if (index !== edge.source && index !== edge.target) {
      boxes.push(nodeBox(node, input.clearance));
    }
  });
  for (const group of input.groups) {
    if (!group.members.has(edge.source) && !group.members.has(edge.target)) {
      boxes.push(expand(group.rect, input.clearance / 2));
    }
  }
  return boxes;
}

// --- curved -------------------------------------------------------------------

function quadAt(p0: Pt, c: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y,
  };
}

// Parameter where the curve crosses the border of `box` (which contains the
// start when fromStart, otherwise the end).
function exitParameter(p0: Pt, c: Pt, p2: Pt, box: Box, fromStart: boolean) {
  let inside = fromStart ? 0 : 1;
  let outside = fromStart ? 1 : 0;
  if (strictlyInside(quadAt(p0, c, p2, outside), box)) return inside;
  for (let i = 0; i < 30; i++) {
    const mid = (inside + outside) / 2;
    if (strictlyInside(quadAt(p0, c, p2, mid), box)) inside = mid;
    else outside = mid;
  }
  return outside;
}

// Exact control points of the sub-curve between t0 and t1 (blossoming).
function subCurve(p0: Pt, c: Pt, p2: Pt, t0: number, t1: number) {
  const blend = (a: number, b: number, k: number) =>
    (1 - t0) * (1 - t1) * a + ((1 - t0) * t1 + t0 * (1 - t1)) * b + t0 * t1 * k;
  return {
    p0: quadAt(p0, c, p2, t0),
    c: { x: blend(p0.x, c.x, p2.x), y: blend(p0.y, c.y, p2.y) },
    p2: quadAt(p0, c, p2, t1),
  };
}

function curveRoute(
  source: RouteNode,
  target: RouteNode,
  control: Pt,
): EdgeRoute {
  const p0 = { x: source.x, y: source.y };
  const p2 = { x: target.x, y: target.y };
  const t0 = exitParameter(p0, control, p2, nodeBox(source), true);
  const t1 = exitParameter(p0, control, p2, nodeBox(target), false);
  const curve = subCurve(p0, control, p2, t0, Math.max(t0, t1));
  const points: Pt[] = [];
  const samples = 16;
  for (let i = 0; i <= samples; i++) {
    points.push(quadAt(curve.p0, curve.c, curve.p2, i / samples));
  }
  return { points, curve };
}

export function routeCurved(input: RouteInput): EdgeRoute[] {
  const obstacles = input.edges.map((edge) => obstaclesFor(input, edge));
  const candidates = input.edges.map((edge) => {
    const s = input.nodes[edge.source];
    const t = input.nodes[edge.target];
    const length = Math.hypot(t.x - s.x, t.y - s.y) || 1;
    const normal = { x: -(t.y - s.y) / length, y: (t.x - s.x) / length };
    // Bulge = how far the curve's apex sits from the straight line, as a
    // fraction of the edge length (the control point sits twice as far). The
    // apex may also sit off-centre to bend around an obstacle near one end.
    const shapes: Array<{ bulge: number; at: number }> = [
      { bulge: 0, at: 0.5 },
    ];
    for (const bulge of [0.08, 0.16, 0.25, 0.35, 0.5, 0.7, 1]) {
      for (const at of [0.5, 0.3, 0.7]) {
        shapes.push({ bulge, at }, { bulge: -bulge, at });
      }
    }
    const controls = shapes.map(({ bulge, at }) => ({
      x: s.x + (t.x - s.x) * at + normal.x * bulge * length * 2,
      y: s.y + (t.y - s.y) * at + normal.y * bulge * length * 2,
    }));
    // Elbows: control points on the corners of the L between the endpoints, so
    // the curve leaves one node and reaches the other along an axis (e.g. a fan
    // from a hub into a column of nodes).
    const midX = (s.x + t.x) / 2;
    const midY = (s.y + t.y) / 2;
    controls.push(
      { x: s.x, y: t.y },
      { x: t.x, y: s.y },
      { x: midX, y: t.y },
      { x: midX, y: s.y },
      { x: s.x, y: midY },
      { x: t.x, y: midY },
    );
    return controls.map((control) => {
      // How far the curve's apex strays from the straight line, relative to
      // the edge length.
      const apex = {
        x: (s.x + 2 * control.x + t.x) / 4,
        y: (s.y + 2 * control.y + t.y) / 4,
      };
      const bulge =
        Math.abs((apex.x - s.x) * normal.x + (apex.y - s.y) * normal.y) /
        length;
      return { bulge, route: curveRoute(s, t, control) };
    });
  });
  // Shortest-first, so evaluation can stop once no remaining shape can beat
  // the best cost found (most edges are fine with an early candidate).
  const ranked = candidates.map((list) =>
    list
      .map(({ bulge, route }) => ({
        route,
        base: polylineLength(route.points) * (1 + bulge),
        bounds: polylineBounds(route.points),
      }))
      .sort((a, b) => a.base - b.base),
  );
  const chosen = ranked.map((list) => list[0].route);
  const chosenBounds = ranked.map((list) => list[0].bounds);
  const order = input.edges
    .map((_, index) => index)
    .sort(
      (a, b) =>
        polylineLength(chosen[b].points) - polylineLength(chosen[a].points),
    );
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const index of order) {
      let best = chosen[index];
      let bestBounds = chosenBounds[index];
      let bestCost = Infinity;
      for (const { route, base, bounds } of ranked[index]) {
        if (base >= bestCost) break;
        let hits = 0;
        for (const box of obstacles[index]) {
          if (boxesOverlap(bounds, box) && polylineHitsBox(route.points, box))
            hits++;
        }
        let crossings = 0;
        for (let other = 0; other < input.edges.length; other++) {
          if (other === index) continue;
          if (!boxesOverlap(bounds, chosenBounds[other])) continue;
          crossings += polylineCrossings(route.points, chosen[other].points);
        }
        const cost = hits * 1e6 + crossings * 1e4 + base;
        if (cost < bestCost - EPS) {
          bestCost = cost;
          best = route;
          bestBounds = bounds;
        }
      }
      if (best !== chosen[index]) {
        chosen[index] = best;
        chosenBounds[index] = bestBounds;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return chosen;
}

// --- orthogonal ---------------------------------------------------------------

class MinHeap {
  private keys: number[] = [];
  private values: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, value: number) {
    const keys = this.keys;
    const values = this.values;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }
  pop(): number {
    const keys = this.keys;
    const values = this.values;
    const top = values[0];
    const lastKey = keys.pop()!;
    const lastValue = values.pop()!;
    if (keys.length > 0) {
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= keys.length) break;
        const right = left + 1;
        const child =
          right < keys.length && keys[right] < keys[left] ? right : left;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}

function uniqueSorted(values: number[], minSpacing: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const result: number[] = [];
  for (const value of sorted) {
    if (result.length === 0 || value - result[result.length - 1] > 0.5)
      result.push(value);
  }
  // Channel centres give routes a line midway between obstacles.
  const withMidpoints: number[] = [];
  for (let i = 0; i < result.length; i++) {
    withMidpoints.push(result[i]);
    if (i + 1 < result.length && result[i + 1] - result[i] > minSpacing * 2) {
      withMidpoints.push((result[i] + result[i + 1]) / 2);
    }
  }
  return withMidpoints;
}

function simplify(points: Pt[]): Pt[] {
  const result: Pt[] = [];
  for (const p of points) {
    const last = result[result.length - 1];
    if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS)
      continue;
    if (result.length >= 2) {
      const prev = result[result.length - 2];
      const collinear =
        (Math.abs(prev.x - last.x) < EPS && Math.abs(last.x - p.x) < EPS) ||
        (Math.abs(prev.y - last.y) < EPS && Math.abs(last.y - p.y) < EPS);
      if (collinear) {
        result[result.length - 1] = p;
        continue;
      }
    }
    result.push(p);
  }
  return result;
}

// Point where the axis-parallel segment a->b leaves `box` (a inside, b outside).
function axisExit(a: Pt, b: Pt, box: Box): Pt {
  if (Math.abs(a.x - b.x) < EPS) {
    return { x: a.x, y: b.y > a.y ? box.maxY : box.minY };
  }
  return { x: b.x > a.x ? box.maxX : box.minX, y: a.y };
}

function clipToBorders(points: Pt[], source: Box, target: Box): Pt[] {
  let start = 0;
  while (start + 1 < points.length && strictlyInside(points[start + 1], source))
    start++;
  let end = points.length - 1;
  while (end - 1 > start && strictlyInside(points[end - 1], target)) end--;
  if (end <= start) return points;
  const clipped = points.slice(start, end + 1);
  clipped[0] = axisExit(points[start], points[start + 1], source);
  clipped[clipped.length - 1] = axisExit(points[end], points[end - 1], target);
  return clipped;
}

export function routeOrthogonal(input: RouteInput): EdgeRoute[] {
  const { nodes, edges, groups, clearance } = input;
  const nodeBoxes = nodes.map((node) => nodeBox(node));
  const paddedNodes = nodes.map((node) => nodeBox(node, clearance));
  const groupBoxes = groups.map((group) => expand(group.rect, clearance / 2));

  const xs: number[] = [];
  const ys: number[] = [];
  nodes.forEach((node, index) => {
    const box = paddedNodes[index];
    xs.push(
      box.minX,
      box.maxX,
      node.x,
      node.x - node.width / 4,
      node.x + node.width / 4,
    );
    ys.push(
      box.minY,
      box.maxY,
      node.y,
      node.y - node.height / 4,
      node.y + node.height / 4,
    );
  });
  for (const box of groupBoxes) {
    xs.push(box.minX - clearance / 2, box.maxX + clearance / 2);
    ys.push(box.minY - clearance / 2, box.maxY + clearance / 2);
  }
  const gx = uniqueSorted(xs, clearance);
  const gy = uniqueSorted(ys, clearance);
  const nx = gx.length;
  const ny = gy.length;
  const total = nx * ny;
  const pointOf = (index: number): Pt => ({
    x: gx[index % nx],
    y: gy[Math.floor(index / nx)],
  });

  // What each grid point / segment midpoint lies strictly inside. Node padding
  // never overlaps, so a single node index suffices; boundaries nest, so keep a
  // list.
  const locate = (p: Pt) => {
    let node = -1;
    for (let i = 0; i < paddedNodes.length; i++) {
      if (strictlyInside(p, paddedNodes[i])) {
        node = i;
        break;
      }
    }
    const inGroups: number[] = [];
    groupBoxes.forEach((box, i) => {
      if (strictlyInside(p, box)) inGroups.push(i);
    });
    return { node, groups: inGroups };
  };
  const pointInfo = Array.from({ length: total }, (_, i) => locate(pointOf(i)));
  // Segment from point i to its +x neighbour (H) or +y neighbour (V).
  const hInfo = Array.from({ length: total }, (_, i) =>
    i % nx < nx - 1
      ? locate({
          x: (gx[i % nx] + gx[(i % nx) + 1]) / 2,
          y: gy[Math.floor(i / nx)],
        })
      : null,
  );
  const vInfo = Array.from({ length: total }, (_, i) =>
    Math.floor(i / nx) < ny - 1
      ? locate({
          x: gx[i % nx],
          y: (gy[Math.floor(i / nx)] + gy[Math.floor(i / nx) + 1]) / 2,
        })
      : null,
  );
  const insideNode = (i: number, node: number) =>
    strictlyInside(pointOf(i), nodeBoxes[node]);

  const hUsage = new Float64Array(total);
  const vUsage = new Float64Array(total);
  // A bend costs as much as a long detour, and a crossing more than any
  // realistic detour, so A* only bends or crosses when it has to.
  const BEND = Math.max(150, clearance * 15);
  const CROSS = 1e5;
  const OVERLAP = 3;

  const routeOne = (edge: RouteEdge): number[] | null => {
    const { source, target } = edge;
    const foreign = groups.map(
      (group) => !group.members.has(source) && !group.members.has(target),
    );
    const blocked = (info: { node: number; groups: number[] } | null) =>
      !info ||
      (info.node >= 0 && info.node !== source && info.node !== target) ||
      info.groups.some((g) => foreign[g]);
    const local = (i: number) => {
      const node = pointInfo[i].node;
      return node === source || node === target;
    };
    const tb = nodeBoxes[target];
    const heuristic = (i: number) => {
      const p = pointOf(i);
      return (
        Math.max(0, tb.minX - p.x, p.x - tb.maxX) +
        Math.max(0, tb.minY - p.y, p.y - tb.maxY)
      );
    };
    const states = total * 5;
    const cost = new Float64Array(states).fill(Infinity);
    const parent = new Int32Array(states).fill(-1);
    const heap = new MinHeap();
    for (let i = 0; i < total; i++) {
      if (insideNode(i, source)) {
        const state = i * 5 + 4;
        cost[state] = 0;
        heap.push(heuristic(i), state);
      }
    }
    while (heap.size > 0) {
      const state = heap.pop();
      const i = Math.floor(state / 5);
      const dir = state % 5;
      if (insideNode(i, target)) {
        const path: number[] = [];
        for (let s = state; s >= 0; s = parent[s]) path.push(Math.floor(s / 5));
        return path.reverse();
      }
      const base = cost[state];
      const col = i % nx;
      const row = Math.floor(i / nx);
      const moves: Array<
        [number, number, (typeof hInfo)[number], Float64Array, number]
      > = [];
      if (col < nx - 1) moves.push([i + 1, 0, hInfo[i], hUsage, i]);
      if (col > 0) moves.push([i - 1, 1, hInfo[i - 1], hUsage, i - 1]);
      if (row < ny - 1) moves.push([i + nx, 2, vInfo[i], vUsage, i]);
      if (row > 0) moves.push([i - nx, 3, vInfo[i - nx], vUsage, i - nx]);
      for (const [next, nextDir, info, usage, segment] of moves) {
        if (blocked(info) || blocked(pointInfo[next])) continue;
        const free = local(i) && local(next);
        const p = pointOf(i);
        const q = pointOf(next);
        const length = Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
        let step = free ? 0 : length * (1 + OVERLAP * usage[segment]);
        if (!free && dir !== 4 && dir !== nextDir) step += BEND;
        const horizontal = nextDir < 2;
        if (!local(next) && (horizontal ? vCross(next) : hCross(next)))
          step += CROSS;
        const nextState = next * 5 + nextDir;
        if (base + step < cost[nextState] - EPS) {
          cost[nextState] = base + step;
          parent[nextState] = state;
          heap.push(base + step + heuristic(next), nextState);
        }
      }
    }
    return null;
  };
  // Whether a perpendicular route already passes through grid point i.
  const vCross = (i: number) =>
    vUsage[i] > 0 || (i - nx >= 0 && vUsage[i - nx] > 0);
  const hCross = (i: number) =>
    hUsage[i] > 0 || (i % nx > 0 && hUsage[i - 1] > 0);

  const markUsage = (path: number[], delta: number, edge: RouteEdge) => {
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      const node = pointInfo[a].node;
      const nodeB = pointInfo[b].node;
      if (
        (node === edge.source || node === edge.target) &&
        (nodeB === edge.source || nodeB === edge.target)
      ) {
        continue;
      }
      const low = Math.min(a, b);
      if (Math.abs(a - b) === 1) hUsage[low] += delta;
      else vUsage[low] += delta;
    }
  };

  const paths: Array<number[] | null> = edges.map(() => null);
  const order = edges
    .map((_, index) => index)
    .sort((a, b) => {
      const length = (e: RouteEdge) =>
        Math.abs(nodes[e.source].x - nodes[e.target].x) +
        Math.abs(nodes[e.source].y - nodes[e.target].y);
      return length(edges[a]) - length(edges[b]);
    });
  for (let pass = 0; pass < 2; pass++) {
    for (const index of order) {
      const edge = edges[index];
      if (paths[index]) markUsage(paths[index]!, -1, edge);
      paths[index] = routeOne(edge);
      if (paths[index]) markUsage(paths[index]!, 1, edge);
    }
  }

  const routes: EdgeRoute[] = edges.map((edge, index) => {
    const path = paths[index];
    const s = nodes[edge.source];
    const t = nodes[edge.target];
    if (!path) {
      return {
        points: [
          { x: s.x, y: s.y },
          { x: t.x, y: t.y },
        ],
      };
    }
    const points = simplify(path.map(pointOf));
    return {
      points: clipToBorders(
        points,
        nodeBoxes[edge.source],
        nodeBoxes[edge.target],
      ),
    };
  });
  return preferSimpleRoutes(input, routes);
}

// Straight, one-bend (L) and two-bend (Z) routes between two nodes, as
// centre-to-centre polylines (clipped to the node borders by the caller).
function simpleOrthogonalShapes(s: RouteNode, t: RouteNode): Pt[][] {
  const shapes: Pt[][] = [];
  const sb = nodeBox(s);
  const tb = nodeBox(t);
  const overlapX = [Math.max(sb.minX, tb.minX), Math.min(sb.maxX, tb.maxX)];
  const overlapY = [Math.max(sb.minY, tb.minY), Math.min(sb.maxY, tb.maxY)];
  // Straight: the boxes share an x (or y) range.
  for (const f of [0.5, 0.25, 0.75]) {
    if (overlapX[1] - overlapX[0] > 8) {
      const x = overlapX[0] + (overlapX[1] - overlapX[0]) * f;
      shapes.push([
        { x, y: s.y },
        { x, y: t.y },
      ]);
    }
    if (overlapY[1] - overlapY[0] > 8) {
      const y = overlapY[0] + (overlapY[1] - overlapY[0]) * f;
      shapes.push([
        { x: s.x, y },
        { x: t.x, y },
      ]);
    }
  }
  // L: leave horizontally then vertically, or the other way round.
  shapes.push(
    [
      { x: s.x, y: s.y },
      { x: t.x, y: s.y },
      { x: t.x, y: t.y },
    ],
    [
      { x: s.x, y: s.y },
      { x: s.x, y: t.y },
      { x: t.x, y: t.y },
    ],
  );
  // Z: two bends with the middle leg at a few positions between the nodes.
  for (const f of [0.5, 0.3, 0.7, 0.15, 0.85]) {
    const mx = s.x + (t.x - s.x) * f;
    const my = s.y + (t.y - s.y) * f;
    shapes.push(
      [
        { x: s.x, y: s.y },
        { x: mx, y: s.y },
        { x: mx, y: t.y },
        { x: t.x, y: t.y },
      ],
      [
        { x: s.x, y: s.y },
        { x: s.x, y: my },
        { x: t.x, y: my },
        { x: t.x, y: t.y },
      ],
    );
  }
  return shapes;
}

function bendCount(points: Pt[]): number {
  return Math.max(0, simplify(points).length - 2);
}

// Replace each A* route by a straight, L or Z route when one is at least as
// good: no more obstacle hits or crossings, then fewer bends, then shorter.
function preferSimpleRoutes(
  input: RouteInput,
  routes: EdgeRoute[],
): EdgeRoute[] {
  const { nodes, edges } = input;
  const obstacles = edges.map((edge) => obstaclesFor(input, edge));
  const rank = (index: number, points: Pt[]) => {
    const bounds = polylineBounds(points);
    let hits = 0;
    for (const box of obstacles[index]) {
      if (boxesOverlap(bounds, box) && polylineHitsBox(points, box)) hits++;
    }
    let crossings = 0;
    let overlaps = 0;
    routes.forEach((other, j) => {
      if (j === index) return;
      if (!boxesOverlap(bounds, polylineBounds(other.points))) return;
      crossings += polylineCrossings(points, other.points);
      overlaps += collinearOverlap(points, other.points) > 2 ? 1 : 0;
    });
    return [
      hits,
      crossings,
      overlaps,
      bendCount(points),
      polylineLength(points),
    ];
  };
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > 1e-6) return a[i] < b[i];
    }
    return false;
  };
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    edges.forEach((edge, index) => {
      const s = nodes[edge.source];
      const t = nodes[edge.target];
      let bestRank = rank(index, routes[index].points);
      for (const shape of simpleOrthogonalShapes(s, t)) {
        const points = simplify(clipToBorders(shape, nodeBox(s), nodeBox(t)));
        if (points.length < 2) continue;
        const candidateRank = rank(index, points);
        if (better(candidateRank, bestRank)) {
          bestRank = candidateRank;
          routes[index] = { points };
          changed = true;
        }
      }
    });
    if (!changed) break;
  }
  return routes;
}

// Length along which two polylines run on top of each other.
function collinearOverlap(p: Pt[], q: Pt[]): number {
  let total = 0;
  for (let i = 1; i < p.length; i++) {
    for (let j = 1; j < q.length; j++) {
      const a = p[i - 1];
      const b = p[i];
      const c = q[j - 1];
      const d = q[j];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < EPS) continue;
      if (Math.abs(orient(a, b, c)) / len > 0.5) continue;
      if (Math.abs(orient(a, b, d)) / len > 0.5) continue;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const tc = (c.x - a.x) * ux + (c.y - a.y) * uy;
      const td = (d.x - a.x) * ux + (d.y - a.y) * uy;
      const lo = Math.max(0, Math.min(tc, td));
      const hi = Math.min(len, Math.max(tc, td));
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

// --- labels -------------------------------------------------------------------

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > EPS) return a[i] - b[i];
  }
  return 0;
}

function pointAlong(points: Pt[], fraction: number) {
  const total = polylineLength(points);
  let remaining = total * fraction;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= length || i === points.length - 1) {
      const t = length > EPS ? Math.min(1, remaining / length) : 0;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        dx: length > EPS ? (b.x - a.x) / length : 1,
        dy: length > EPS ? (b.y - a.y) / length : 0,
      };
    }
    remaining -= length;
  }
  return { x: points[0].x, y: points[0].y, dx: 1, dy: 0 };
}

function labelBox(spot: Pt, width: number, height: number): Box {
  return {
    minX: spot.x - width / 2 - 4,
    maxX: spot.x + width / 2 + 4,
    minY: spot.y - height / 2 - 2,
    maxY: spot.y + height / 2 + 2,
  };
}

export function placeRouteLabels(
  input: RouteInput,
  routes: EdgeRoute[],
): Array<LabelSpot | null> {
  const nodeBoxes = input.nodes.map((node) => nodeBox(node, 2));
  const placed: Box[] = [];
  const routeBounds = routes.map((route) => polylineBounds(route.points));
  return input.edges.map((edge, index) => {
    const width = edge.labelWidth ?? 0;
    const height = edge.labelHeight ?? 0;
    if (!width || !height) return null;
    const route = routes[index];
    let best: { spot: LabelSpot; box: Box; rank: number[] } | null = null;
    for (const fraction of [
      0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82, 0.1, 0.9,
    ]) {
      const at = pointAlong(route.points, fraction);
      const normal = { x: -at.dy, y: at.dx };
      const reach =
        Math.abs(normal.x) * (width / 2) + Math.abs(normal.y) * (height / 2);
      for (const offset of [
        reach + 6,
        reach + 6 + input.clearance * 2,
        reach + 6 + input.clearance * 5,
      ]) {
        for (const side of [1, -1]) {
          const spot = {
            x: at.x + normal.x * offset * side,
            y: at.y + normal.y * offset * side,
            anchorX: at.x,
            anchorY: at.y,
          };
          const box = labelBox(spot, width, height);
          let hard = 0;
          for (const other of nodeBoxes) if (boxesOverlap(box, other)) hard++;
          for (const other of placed)
            if (boxesOverlap(box, expand(other, 2))) hard++;
          let soft = 0;
          routes.forEach((other, otherIndex) => {
            if (
              boxesOverlap(box, routeBounds[otherIndex]) &&
              polylineHitsBox(other.points, box)
            ) {
              soft++;
            }
          });
          const rank = [hard, soft, Math.abs(fraction - 0.5), offset];
          if (!best || compareRanks(rank, best.rank) < 0) {
            best = { spot, box, rank };
          }
        }
      }
    }
    placed.push(best!.box);
    return best!.spot;
  });
}

// Indices of routes passing through a node or boundary they must avoid.
export function obstacleHits(input: RouteInput, routes: EdgeRoute[]): number[] {
  const hit: number[] = [];
  input.edges.forEach((edge, index) => {
    const points = routes[index].points;
    const bounds = polylineBounds(points);
    for (const box of obstaclesFor({ ...input, clearance: 0 }, edge)) {
      if (boxesOverlap(bounds, box) && polylineHitsBox(points, box)) {
        hit.push(index);
        return;
      }
    }
  });
  return hit;
}

export function routeEdges(input: RouteInput, mode: EdgeRouting): EdgeRoute[] {
  if (mode === "curved") return routeCurved(input);
  if (mode === "orthogonal") return routeOrthogonal(input);
  return input.edges.map((edge) => {
    const s = input.nodes[edge.source];
    const t = input.nodes[edge.target];
    return {
      points: [
        { x: s.x, y: s.y },
        { x: t.x, y: t.y },
      ],
    };
  });
}
