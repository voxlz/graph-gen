import {
  minimizeLayout,
  type MinimizeMeasure,
  type MinimizeObstacle,
} from "./minimize";

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  boundaryParent: string | null;
}

export interface LayoutBoundary {
  id: string;
  parent?: string | null;
  draw?: boolean;
}

export interface LayoutEdge {
  source: number | LayoutNode;
  target: number | LayoutNode;
  label?: string;
  labelWidth?: number;
  labelHeight?: number;
  labelX?: number;
  labelY?: number;
  labelAnchorX?: number;
  labelAnchorY?: number;
}

interface LayoutRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LayoutConstraint {
  type: string;
  axis?: "x" | "y";
  ids?: string[];
  a?: string;
  b?: string;
  left?: string;
  right?: string;
  top?: string;
  bottom?: string;
}

export interface LayoutOptions {
  minGap: number;
  nodeGap: number;
  boundaryPad: number;
  labelBand: number;
  nestPad: number;
  iterations: number;
  stableIterations?: number;
  debugFrameEvery?: number;
  minimizeIterations?: number;
  preserveInitialPositions?: boolean;
}

export interface LayoutSnapshot {
  iteration: number;
  phase: "force" | "repair" | "labels" | "final";
  violations: number;
  nodes: Array<Pick<LayoutNode, "id" | "x" | "y" | "width" | "height">>;
  groups: Array<{ id: string; rect: LayoutRect | null }>;
  labels: Array<{
    edge: number;
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export interface LayoutResult {
  valid: boolean;
  iterations: number;
  violations: string[];
  groups: Map<string, LayoutRect>;
  snapshots: LayoutSnapshot[];
}

interface LayoutContext {
  nodes: LayoutNode[];
  boundaries: LayoutBoundary[];
  edges: LayoutEdge[];
  constraints: LayoutConstraint[];
  options: LayoutOptions;
  nodeById: Map<string, LayoutNode>;
  nodeIndex: Map<LayoutNode, number>;
  boundaryById: Map<string, LayoutBoundary>;
  members: Map<string, number[]>;
  alignments: Record<"x" | "y", LayoutNode[][]>;
  maxDepth: number;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface LabelPlacement {
  edge: number;
  rect: LayoutRect;
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  hardCollisions: number;
  lineCollisions: number;
}

interface MoveCandidate {
  entity?: string;
  entities?: string[];
  dx: number;
  dy: number;
}

function translateEntities(
  ctx: LayoutContext,
  ids: string[],
  dx: number,
  dy: number,
) {
  const movingNodes = nodesForEntities(ctx, ids);
  const xNodes = alignedNodes(ctx, movingNodes, "x");
  const yNodes = alignedNodes(ctx, movingNodes, "y");
  if (dx !== 0) {
    for (const node of xNodes) node.x += dx;
  }
  if (dy !== 0) {
    for (const node of yNodes) node.y += dy;
  }
}

function nodesForEntities(ctx: LayoutContext, ids: string[]): Set<LayoutNode> {
  const result = new Set<LayoutNode>();
  for (const id of ids) {
    const node = ctx.nodeById.get(id);
    if (node) result.add(node);
    for (const index of ctx.members.get(id) ?? []) {
      result.add(ctx.nodes[index]);
    }
  }
  return result;
}

function alignedNodes(
  ctx: LayoutContext,
  nodes: Set<LayoutNode>,
  axis: "x" | "y",
): Set<LayoutNode> {
  const result = new Set(nodes);
  for (const alignment of ctx.alignments[axis]) {
    if (alignment.some((node) => result.has(node))) {
      for (const node of alignment) result.add(node);
    }
  }
  return result;
}

const EPSILON = 0.01;
const NODE_EDGE_CLEARANCE = 8;

function rectanglesOverlap(a: LayoutRect, b: LayoutRect): boolean {
  return (
    a.minX < b.maxX - EPSILON &&
    a.maxX > b.minX + EPSILON &&
    a.minY < b.maxY - EPSILON &&
    a.maxY > b.minY + EPSILON
  );
}

function segmentsCross(a: Segment, b: Segment): boolean {
  const orient = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const a1 = orient(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const a2 = orient(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const b1 = orient(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const b2 = orient(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  const properCrossing =
    ((a1 > EPSILON && a2 < -EPSILON) || (a1 < -EPSILON && a2 > EPSILON)) &&
    ((b1 > EPSILON && b2 < -EPSILON) || (b1 < -EPSILON && b2 > EPSILON));
  if (properCrossing) return true;
  const onSegment = (
    pointX: number,
    pointY: number,
    segment: Segment,
    orientation: number,
  ) =>
    Math.abs(orientation) <= EPSILON &&
    pointX >= Math.min(segment.x1, segment.x2) - EPSILON &&
    pointX <= Math.max(segment.x1, segment.x2) + EPSILON &&
    pointY >= Math.min(segment.y1, segment.y2) - EPSILON &&
    pointY <= Math.max(segment.y1, segment.y2) + EPSILON;
  return (
    onSegment(b.x1, b.y1, a, a1) ||
    onSegment(b.x2, b.y2, a, a2) ||
    onSegment(a.x1, a.y1, b, b1) ||
    onSegment(a.x2, a.y2, b, b2)
  );
}

function segmentIntersectsRect(segment: Segment, rect: LayoutRect): boolean {
  let low = 0;
  let high = 1;
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const clips: Array<[number, number]> = [
    [-dx, segment.x1 - rect.minX],
    [dx, rect.maxX - segment.x1],
    [-dy, segment.y1 - rect.minY],
    [dy, rect.maxY - segment.y1],
  ];
  for (const [direction, distance] of clips) {
    if (Math.abs(direction) < EPSILON) {
      if (distance < 0) return false;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) low = Math.max(low, ratio);
    else high = Math.min(high, ratio);
    if (low > high) return false;
  }
  return true;
}

function nodeRect(node: LayoutNode, padding = 0): LayoutRect {
  return {
    minX: node.x - node.width / 2 - padding,
    maxX: node.x + node.width / 2 + padding,
    minY: node.y - node.height / 2 - padding,
    maxY: node.y + node.height / 2 + padding,
  };
}

function rectCenter(rect: LayoutRect) {
  return {
    x: (rect.minX + rect.maxX) / 2,
    y: (rect.minY + rect.maxY) / 2,
  };
}

function expandRect(rect: LayoutRect, padding: number): LayoutRect {
  return {
    minX: rect.minX - padding,
    maxX: rect.maxX + padding,
    minY: rect.minY - padding,
    maxY: rect.maxY + padding,
  };
}

function rectFromMembers(
  ctx: LayoutContext,
  boundaryId: string,
): LayoutRect | null {
  const members = ctx.members.get(boundaryId) ?? [];
  if (members.length === 0) return null;
  const boundary = ctx.boundaryById.get(boundaryId);
  const depth = boundaryDepth(ctx, boundaryId);
  const visible = boundary?.draw !== false;
  const padding = visible
    ? ctx.options.boundaryPad + ctx.options.nestPad * (ctx.maxDepth - depth)
    : 0;
  const labelBand = visible ? ctx.options.labelBand : 0;
  const rect = members.reduce<LayoutRect>(
    (result, index) => {
      const current = nodeRect(ctx.nodes[index]);
      result.minX = Math.min(result.minX, current.minX);
      result.maxX = Math.max(result.maxX, current.maxX);
      result.minY = Math.min(result.minY, current.minY);
      result.maxY = Math.max(result.maxY, current.maxY);
      return result;
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  return {
    minX: rect.minX - padding,
    maxX: rect.maxX + padding,
    minY: rect.minY - padding - labelBand,
    maxY: rect.maxY + padding,
  };
}

function allGroupRects(ctx: LayoutContext): Map<string, LayoutRect> {
  const result = new Map<string, LayoutRect>();
  for (const boundary of ctx.boundaries) {
    const rect = rectFromMembers(ctx, boundary.id);
    if (rect) result.set(boundary.id, rect);
  }
  return result;
}

function boundsOfRects(rects: LayoutRect[]): LayoutRect | null {
  if (rects.length === 0) return null;
  return rects.reduce<LayoutRect>(
    (bounds, rect) => ({
      minX: Math.min(bounds.minX, rect.minX),
      minY: Math.min(bounds.minY, rect.minY),
      maxX: Math.max(bounds.maxX, rect.maxX),
      maxY: Math.max(bounds.maxY, rect.maxY),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

function boundaryDepth(ctx: LayoutContext, boundaryId: string): number {
  let depth = 0;
  let current = ctx.boundaryById.get(boundaryId);
  const seen = new Set<string>();
  while (current?.parent && !seen.has(current.parent)) {
    seen.add(current.parent);
    depth++;
    current = ctx.boundaryById.get(current.parent);
  }
  return depth;
}

function belongsTo(ctx: LayoutContext, nodeIndex: number, boundaryId: string) {
  return ctx.members.get(boundaryId)?.includes(nodeIndex) ?? false;
}

function isAncestor(ctx: LayoutContext, ancestor: string, child: string) {
  let current = ctx.boundaryById.get(child)?.parent;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = ctx.boundaryById.get(current)?.parent;
  }
  return false;
}

function entityRect(ctx: LayoutContext, id: string): LayoutRect | null {
  const node = ctx.nodeById.get(id);
  if (node) return nodeRect(node);
  return rectFromMembers(ctx, id);
}

function translateEntity(
  ctx: LayoutContext,
  id: string,
  dx: number,
  dy: number,
) {
  translateEntities(ctx, [id], dx, dy);
}

function translateEntityRaw(
  ctx: LayoutContext,
  id: string,
  dx: number,
  dy: number,
) {
  const node = ctx.nodeById.get(id);
  if (node) {
    node.x += dx;
    node.y += dy;
    return;
  }
  for (const index of ctx.members.get(id) ?? []) {
    ctx.nodes[index].x += dx;
    ctx.nodes[index].y += dy;
  }
}

function ancestors(ctx: LayoutContext, nodeIndex: number): string[] {
  const result: string[] = [];
  let current = ctx.nodes[nodeIndex].boundaryParent;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = ctx.boundaryById.get(current)?.parent ?? null;
  }
  return result;
}

function movableNodeEntity(
  ctx: LayoutContext,
  nodeIndex: number,
  otherAncestors: Set<string>,
): string {
  for (const boundary of ancestors(ctx, nodeIndex)) {
    if (!otherAncestors.has(boundary)) return boundary;
  }
  return ctx.nodes[nodeIndex].id;
}

function resolveNode(ref: number | LayoutNode, ctx: LayoutContext): LayoutNode {
  return typeof ref === "number" ? ctx.nodes[ref] : ref;
}

function edgeNodeIndices(
  edge: LayoutEdge,
  ctx: LayoutContext,
): [number, number] {
  const source = resolveNode(edge.source, ctx);
  const target = resolveNode(edge.target, ctx);
  return [
    ctx.nodeIndex.get(source) as number,
    ctx.nodeIndex.get(target) as number,
  ];
}

function boundaryPoint(node: LayoutNode, towardX: number, towardY: number) {
  const dx = towardX - node.x;
  const dy = towardY - node.y;
  if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) {
    return { x: node.x, y: node.y };
  }
  const scaleX = dx === 0 ? Infinity : node.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : node.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

function edgeSegment(edge: LayoutEdge, ctx: LayoutContext): Segment {
  const source = resolveNode(edge.source, ctx);
  const target = resolveNode(edge.target, ctx);
  const start = boundaryPoint(source, target.x, target.y);
  const end = boundaryPoint(target, source.x, source.y);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

function initializeGrid(ctx: LayoutContext) {
  const directNodes = new Map<string | null, number[]>();
  for (const [index, node] of ctx.nodes.entries()) {
    const key = node.boundaryParent ?? null;
    const list = directNodes.get(key) ?? [];
    list.push(index);
    directNodes.set(key, list);
  }
  const childBoundaries = new Map<string | null, string[]>();
  for (const boundary of ctx.boundaries) {
    const key = boundary.parent ?? null;
    const list = childBoundaries.get(key) ?? [];
    list.push(boundary.id);
    childBoundaries.set(key, list);
  }

  const layoutContainer = (parent: string | null) => {
    for (const child of childBoundaries.get(parent) ?? [])
      layoutContainer(child);
    const items: Array<{ id: string; rect: LayoutRect }> = [];
    for (const index of directNodes.get(parent) ?? []) {
      items.push({ id: ctx.nodes[index].id, rect: nodeRect(ctx.nodes[index]) });
    }
    for (const id of childBoundaries.get(parent) ?? []) {
      const rect = rectFromMembers(ctx, id);
      if (rect) items.push({ id, rect });
    }
    if (items.length === 0) return;
    const columns = Math.ceil(Math.sqrt(items.length));
    const rows = Math.ceil(items.length / columns);
    const cellWidth =
      Math.max(...items.map(({ rect }) => rect.maxX - rect.minX)) +
      ctx.options.nodeGap;
    const cellHeight =
      Math.max(...items.map(({ rect }) => rect.maxY - rect.minY)) +
      ctx.options.nodeGap;
    for (const [index, item] of items.entries()) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const targetX = (column - (columns - 1) / 2) * cellWidth;
      const targetY = (row - (rows - 1) / 2) * cellHeight;
      const center = rectCenter(item.rect);
      translateEntityRaw(ctx, item.id, targetX - center.x, targetY - center.y);
    }
  };
  layoutContainer(null);
}

function resolveAlignmentConstraints(ctx: LayoutContext) {
  for (const axis of ["x", "y"] as const) {
    for (const nodes of ctx.alignments[axis]) {
      const coordinate =
        nodes.reduce((sum, node) => sum + node[axis], 0) / nodes.length;
      for (const node of nodes) node[axis] = coordinate;
    }
  }
}

function directionalCorrection(
  type: string,
  a: LayoutRect,
  b: LayoutRect,
  gap: number,
) {
  let dx = 0;
  let dy = 0;
  if (["left", "topleft", "bottomleft"].includes(type)) {
    const violation = a.maxX + gap - b.minX;
    if (violation > 0) dx = -violation;
  }
  if (["right", "topright", "bottomright"].includes(type)) {
    const violation = b.maxX + gap - a.minX;
    if (violation > 0) dx = violation;
  }
  if (["top", "topleft", "topright"].includes(type)) {
    const violation = a.maxY + gap - b.minY;
    if (violation > 0) dy = -violation;
  }
  if (["bottom", "bottomleft", "bottomright"].includes(type)) {
    const violation = b.maxY + gap - a.minY;
    if (violation > 0) dy = violation;
  }
  return { dx, dy };
}

function resolveDirectionalConstraints(ctx: LayoutContext) {
  for (const constraint of ctx.constraints) {
    if (constraint.type === "near" || constraint.type === "align") continue;
    const aId = constraint.a ?? constraint.left ?? constraint.top;
    const bId = constraint.b ?? constraint.right ?? constraint.bottom;
    if (!aId || !bId) continue;
    const a = entityRect(ctx, aId);
    const b = entityRect(ctx, bId);
    if (!a || !b) continue;
    const correction = directionalCorrection(
      constraint.type,
      a,
      b,
      Math.max(ctx.options.minGap, ctx.options.nodeGap),
    );
    if (correction.dx || correction.dy) {
      chooseBestMove(
        ctx,
        [
          {
            entities: directionalClosure(
              ctx,
              aId,
              correction.dx,
              correction.dy,
            ),
            dx: correction.dx,
            dy: correction.dy,
          },
          {
            entities: directionalClosure(
              ctx,
              bId,
              -correction.dx,
              -correction.dy,
            ),
            dx: -correction.dx,
            dy: -correction.dy,
          },
        ],
        () => {
          const movedA = entityRect(ctx, aId);
          const movedB = entityRect(ctx, bId);
          if (!movedA || !movedB) return false;
          const remaining = directionalCorrection(
            constraint.type,
            movedA,
            movedB,
            Math.max(ctx.options.minGap, ctx.options.nodeGap),
          );
          return (
            Math.abs(remaining.dx) <= EPSILON &&
            Math.abs(remaining.dy) <= EPSILON
          );
        },
      );
    }
  }
}

function directionalClosure(
  ctx: LayoutContext,
  startId: string,
  dx: number,
  dy: number,
): string[] {
  const ids = new Set([startId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const constraint of ctx.constraints) {
      const aId = constraint.a ?? constraint.left ?? constraint.top;
      const bId = constraint.b ?? constraint.right ?? constraint.bottom;
      if (!aId || !bId) continue;
      const xRelation = directionalRelation(constraint.type, "x", aId, bId);
      const yRelation = directionalRelation(constraint.type, "y", aId, bId);
      for (const [relation, delta] of [
        [xRelation, dx],
        [yRelation, dy],
      ] as const) {
        if (!relation || delta === 0) continue;
        const [before, after] = relation;
        const dependency = delta < 0 && ids.has(after) ? before : null;
        const dependent = delta > 0 && ids.has(before) ? after : null;
        const next = dependency ?? dependent;
        if (next && !ids.has(next)) {
          ids.add(next);
          changed = true;
        }
      }
    }
  }
  return [...ids];
}

function directionalRelation(
  type: string,
  axis: "x" | "y",
  aId: string,
  bId: string,
): [string, string] | null {
  if (axis === "x") {
    if (["left", "topleft", "bottomleft"].includes(type)) return [aId, bId];
    if (["right", "topright", "bottomright"].includes(type)) return [bId, aId];
  } else {
    if (["top", "topleft", "topright"].includes(type)) return [aId, bId];
    if (["bottom", "bottomleft", "bottomright"].includes(type))
      return [bId, aId];
  }
  return null;
}

function resolveNodeOverlaps(ctx: LayoutContext) {
  const packAlignment = (nodes: LayoutNode[], axis: "x" | "y"): void => {
    const size = axis === "x" ? "width" : "height";
    const ordered = [...nodes].sort(
      (a, b) => a[axis] - b[axis] || a.id.localeCompare(b.id),
    );
    let trailing = ordered[0][axis] + ordered[0][size] / 2;
    for (const node of ordered.slice(1)) {
      const minimum = trailing + ctx.options.nodeGap + node[size] / 2;
      if (node[axis] < minimum - EPSILON) {
        translateEntities(
          ctx,
          [node.id],
          axis === "x" ? minimum - node[axis] : 0,
          axis === "y" ? minimum - node[axis] : 0,
        );
      }
      trailing = node[axis] + node[size] / 2;
    }
  };
  for (const nodes of ctx.alignments.x) packAlignment(nodes, "y");
  for (const nodes of ctx.alignments.y) packAlignment(nodes, "x");

  const padding = ctx.options.nodeGap / 2;
  for (let first = 0; first < ctx.nodes.length; first++) {
    for (let second = first + 1; second < ctx.nodes.length; second++) {
      const a = expandRect(nodeRect(ctx.nodes[first]), padding);
      const b = expandRect(nodeRect(ctx.nodes[second]), padding);
      if (!rectanglesOverlap(a, b)) continue;
      const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      const entity = movableNodeEntity(
        ctx,
        second,
        new Set(ancestors(ctx, first)),
      );
      if (overlapX <= overlapY) {
        const direction = ctx.nodes[second].x >= ctx.nodes[first].x ? 1 : -1;
        translateEntity(ctx, entity, direction * (overlapX + EPSILON), 0);
      } else {
        const direction = ctx.nodes[second].y >= ctx.nodes[first].y ? 1 : -1;
        translateEntity(ctx, entity, 0, direction * (overlapY + EPSILON));
      }
    }
  }
}

function resolveBoundaryOverlaps(ctx: LayoutContext) {
  let rects = allGroupRects(ctx);
  for (let first = 0; first < ctx.boundaries.length; first++) {
    for (let second = first + 1; second < ctx.boundaries.length; second++) {
      const aId = ctx.boundaries[first].id;
      const bId = ctx.boundaries[second].id;
      if (isAncestor(ctx, aId, bId) || isAncestor(ctx, bId, aId)) continue;
      const a = rects.get(aId);
      const b = rects.get(bId);
      if (!a || !b || !rectanglesOverlap(a, b)) continue;
      const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      const ac = rectCenter(a);
      const bc = rectCenter(b);
      if (overlapX <= overlapY) {
        translateEntity(
          ctx,
          bId,
          (bc.x >= ac.x ? 1 : -1) * (overlapX + ctx.options.nodeGap),
          0,
        );
      } else {
        translateEntity(
          ctx,
          bId,
          0,
          (bc.y >= ac.y ? 1 : -1) * (overlapY + ctx.options.nodeGap),
        );
      }
      rects = allGroupRects(ctx);
    }
  }

  for (const boundary of ctx.boundaries) {
    const boundaryRect = rects.get(boundary.id);
    if (!boundaryRect) continue;
    for (let index = 0; index < ctx.nodes.length; index++) {
      if (belongsTo(ctx, index, boundary.id)) continue;
      const rect = nodeRect(ctx.nodes[index], ctx.options.nodeGap / 2);
      if (!rectanglesOverlap(boundaryRect, rect)) continue;
      const entity = movableNodeEntity(
        ctx,
        index,
        new Set([boundary.id, ...boundaryAncestors(ctx, boundary.id)]),
      );
      chooseBestMove(
        ctx,
        [
          {
            entity,
            dx: boundaryRect.minX - rect.maxX - EPSILON,
            dy: 0,
          },
          {
            entity,
            dx: boundaryRect.maxX - rect.minX + EPSILON,
            dy: 0,
          },
          {
            entity,
            dx: 0,
            dy: boundaryRect.minY - rect.maxY - EPSILON,
          },
          {
            entity,
            dx: 0,
            dy: boundaryRect.maxY - rect.minY + EPSILON,
          },
        ],
        () =>
          !rectanglesOverlap(
            boundaryRect,
            nodeRect(ctx.nodes[index], ctx.options.nodeGap / 2),
          ),
      );
      rects = allGroupRects(ctx);
    }
  }
}

function boundaryAncestors(ctx: LayoutContext, boundaryId: string): string[] {
  const result: string[] = [];
  let current = ctx.boundaryById.get(boundaryId)?.parent;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = ctx.boundaryById.get(current)?.parent;
  }
  return result;
}

function signedDistance(point: { x: number; y: number }, line: Segment) {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const length = Math.hypot(dx, dy) || 1;
  return ((point.x - line.x1) * -dy + (point.y - line.y1) * dx) / length;
}

function lineNormal(line: Segment) {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

function chooseBestMove(
  ctx: LayoutContext,
  candidates: MoveCandidate[],
  targetResolved?: () => boolean,
) {
  const original = ctx.nodes.map((node) => ({ x: node.x, y: node.y }));
  const baselineScore = violationScore(collectViolations(ctx, false).messages);
  let best: (typeof candidates)[number] | null = null;
  let bestScore = Infinity;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    translateEntities(
      ctx,
      candidate.entities ?? (candidate.entity ? [candidate.entity] : []),
      candidate.dx,
      candidate.dy,
    );
    if (targetResolved && !targetResolved()) {
      ctx.nodes.forEach((node, index) => {
        node.x = original[index].x;
        node.y = original[index].y;
      });
      continue;
    }
    const score = violationScore(collectViolations(ctx, false).messages);
    const distance = Math.hypot(candidate.dx, candidate.dy);
    if (score < bestScore || (score === bestScore && distance < bestDistance)) {
      best = candidate;
      bestScore = score;
      bestDistance = distance;
    }
    ctx.nodes.forEach((node, index) => {
      node.x = original[index].x;
      node.y = original[index].y;
    });
  }
  if (best && (targetResolved || bestScore < baselineScore)) {
    translateEntities(
      ctx,
      best.entities ?? (best.entity ? [best.entity] : []),
      best.dx,
      best.dy,
    );
  }
}

function violationScore(messages: string[]): number {
  return messages.reduce((score, message) => {
    if (
      message.startsWith("directional constraint") ||
      message.startsWith("alignment constraint")
    ) {
      return score + 1_000_000;
    }
    if (
      message.startsWith("node clearance") ||
      message.startsWith("group overlap") ||
      message.startsWith("node ")
    ) {
      return score + 100_000;
    }
    if (
      message.includes("intersects node") ||
      message.includes("intersects group")
    ) {
      return score + 10_000;
    }
    if (message.startsWith("edges ")) return score + 1_000;
    return score + 1;
  }, 0);
}

function resolveNodeEdgeIntersections(ctx: LayoutContext) {
  for (const edge of ctx.edges) {
    const [source, target] = edgeNodeIndices(edge, ctx);
    const segment = edgeSegment(edge, ctx);
    const normal = lineNormal(segment);
    for (let index = 0; index < ctx.nodes.length; index++) {
      if (index === source || index === target) continue;
      const node = ctx.nodes[index];
      if (!segmentIntersectsRect(segment, nodeRect(node, NODE_EDGE_CLEARANCE)))
        continue;
      const distance = signedDistance(node, segment);
      const projectedHalfExtent =
        Math.abs(normal.x) * (node.width / 2) +
        Math.abs(normal.y) * (node.height / 2);
      const movement = Math.max(
        projectedHalfExtent + Math.abs(distance) + NODE_EDGE_CLEARANCE,
        4,
      );
      const preferredDirection =
        Math.abs(distance) < EPSILON
          ? index % 2
            ? 1
            : -1
          : Math.sign(distance);
      const endpointMovement =
        Math.max(node.width, node.height) + ctx.options.nodeGap;
      chooseBestMove(
        ctx,
        [
          {
            entity: node.id,
            dx: normal.x * preferredDirection * movement,
            dy: normal.y * preferredDirection * movement,
          },
          {
            entity: node.id,
            dx: -normal.x * preferredDirection * movement,
            dy: -normal.y * preferredDirection * movement,
          },
          ...[-1, 1].flatMap((direction) => [
            {
              entity: node.id,
              dx: direction * endpointMovement,
              dy: 0,
            },
            {
              entity: node.id,
              dx: 0,
              dy: direction * endpointMovement,
            },
          ]),
          ...[source, target].flatMap((endpoint) =>
            [-1, 1].map((direction) => ({
              entity: ctx.nodes[endpoint].id,
              dx: normal.x * direction * endpointMovement,
              dy: normal.y * direction * endpointMovement,
            })),
          ),
        ],
        () =>
          !segmentIntersectsRect(
            edgeSegment(edge, ctx),
            nodeRect(node, NODE_EDGE_CLEARANCE),
          ),
      );
    }
  }
}

function resolveEdgeBoundaryIntersections(ctx: LayoutContext) {
  const rects = allGroupRects(ctx);
  for (const edge of ctx.edges) {
    const [source, target] = edgeNodeIndices(edge, ctx);
    const segment = edgeSegment(edge, ctx);
    const normal = lineNormal(segment);
    for (const boundary of ctx.boundaries) {
      if (
        belongsTo(ctx, source, boundary.id) ||
        belongsTo(ctx, target, boundary.id)
      ) {
        continue;
      }
      const rect = rects.get(boundary.id);
      if (!rect || !segmentIntersectsRect(segment, rect)) continue;
      const center = rectCenter(rect);
      const distance = signedDistance(center, segment);
      const halfWidth = (rect.maxX - rect.minX) / 2;
      const halfHeight = (rect.maxY - rect.minY) / 2;
      const projectedHalfExtent =
        Math.abs(normal.x) * halfWidth + Math.abs(normal.y) * halfHeight;
      const direction = Math.abs(distance) < EPSILON ? 1 : Math.sign(distance);
      const movement =
        projectedHalfExtent + ctx.options.nodeGap / 2 - Math.abs(distance);
      translateEntity(
        ctx,
        boundary.id,
        normal.x * direction * Math.max(movement, 4),
        normal.y * direction * Math.max(movement, 4),
      );
    }
  }
}

function resolveEdgeCrossings(ctx: LayoutContext) {
  for (let first = 0; first < ctx.edges.length; first++) {
    const firstNodes = edgeNodeIndices(ctx.edges[first], ctx);
    for (let second = first + 1; second < ctx.edges.length; second++) {
      const secondNodes = edgeNodeIndices(ctx.edges[second], ctx);
      if (firstNodes.some((node) => secondNodes.includes(node))) continue;
      const a = edgeSegment(ctx.edges[first], ctx);
      const b = edgeSegment(ctx.edges[second], ctx);
      if (!segmentsCross(a, b)) continue;
      const normal = lineNormal(a);
      const fixedNode = ctx.nodes[secondNodes[0]];
      const movingNode = ctx.nodes[secondNodes[1]];
      const fixedSide = signedDistance(fixedNode, a);
      const movingSide = signedDistance(movingNode, a);
      const desiredSign =
        Math.abs(fixedSide) < EPSILON ? 1 : Math.sign(fixedSide);
      const desiredDistance = desiredSign * (ctx.options.nodeGap / 2 + 2);
      const movement = desiredDistance - movingSide;
      const amount = Math.max(Math.abs(movement), ctx.options.nodeGap / 2 + 2);
      const endpointAmount = Math.max(
        ...[...firstNodes, ...secondNodes].map((nodeIndex) => {
          const node = ctx.nodes[nodeIndex];
          return Math.max(node.width, node.height) + ctx.options.nodeGap;
        }),
      );
      const candidates: MoveCandidate[] = [
        ...firstNodes,
        ...secondNodes,
      ].flatMap((nodeIndex) => {
        const node = ctx.nodes[nodeIndex];
        const entities = [node.id];
        if (node.boundaryParent) entities.push(node.boundaryParent);
        return entities.flatMap((entity) =>
          [-1, 1].flatMap((direction) =>
            [1, 2, 4, 8, 16].flatMap((scale) => [
              {
                entity,
                dx: normal.x * direction * amount * scale,
                dy: normal.y * direction * amount * scale,
              },
              {
                entity,
                dx: direction * endpointAmount * scale,
                dy: 0,
              },
              {
                entity,
                dx: 0,
                dy: direction * endpointAmount * scale,
              },
            ]),
          ),
        );
      });
      for (const nodeIndices of [firstNodes, secondNodes]) {
        const entities = nodeIndices.map(
          (nodeIndex) => ctx.nodes[nodeIndex].id,
        );
        for (const direction of [-1, 1]) {
          for (const scale of [1, 2, 4, 8, 16]) {
            candidates.push(
              {
                entities,
                dx: normal.x * direction * endpointAmount * scale,
                dy: normal.y * direction * endpointAmount * scale,
              },
              {
                entities,
                dx: direction * endpointAmount * scale,
                dy: 0,
              },
              {
                entities,
                dx: 0,
                dy: direction * endpointAmount * scale,
              },
            );
          }
        }
      }
      for (const [sourceIndex, targetIndex] of [firstNodes, secondNodes]) {
        const source = ctx.nodes[sourceIndex];
        const target = ctx.nodes[targetIndex];
        for (const fraction of [0.25, 0.5, 0.75]) {
          candidates.push(
            {
              entity: source.id,
              dx: (target.x - source.x) * fraction,
              dy: (target.y - source.y) * fraction,
            },
            {
              entity: target.id,
              dx: (source.x - target.x) * fraction,
              dy: (source.y - target.y) * fraction,
            },
          );
        }
      }
      chooseBestMove(
        ctx,
        candidates,
        () =>
          !segmentsCross(
            edgeSegment(ctx.edges[first], ctx),
            edgeSegment(ctx.edges[second], ctx),
          ),
      );
    }
  }
}

function placeLabels(ctx: LayoutContext): LabelPlacement[] {
  const placements: LabelPlacement[] = [];
  for (const [edgeIndex, edge] of ctx.edges.entries()) {
    if (!edge.label || !edge.labelWidth || !edge.labelHeight) continue;
    const segment = edgeSegment(edge, ctx);
    const normal = lineNormal(segment);
    const [sourceIndex, targetIndex] = edgeNodeIndices(edge, ctx);
    const endpointClearance =
      Math.max(
        ...[sourceIndex, targetIndex].map((index) => {
          const node = ctx.nodes[index];
          return (
            Math.abs(normal.x) * (node.width / 2) +
            Math.abs(normal.y) * (node.height / 2)
          );
        }),
      ) +
      edge.labelHeight / 2 +
      6;
    const offsets = [
      edge.labelHeight / 2 + 6,
      endpointClearance,
      endpointClearance + ctx.options.nodeGap / 2,
    ];
    const candidates: LabelPlacement[] = [];
    for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const anchorX = segment.x1 + (segment.x2 - segment.x1) * t;
      const anchorY = segment.y1 + (segment.y2 - segment.y1) * t;
      for (const offset of offsets) {
        for (const direction of [-1, 1]) {
          const x = anchorX + normal.x * offset * direction;
          const y = anchorY + normal.y * offset * direction;
          const rect = {
            minX: x - edge.labelWidth / 2 - 4,
            maxX: x + edge.labelWidth / 2 + 4,
            minY: y - edge.labelHeight / 2 - 2,
            maxY: y + edge.labelHeight / 2 + 2,
          };
          const nodeCollisions = ctx.nodes.filter((node) =>
            rectanglesOverlap(rect, nodeRect(node, 2)),
          ).length;
          const labelCollisions = placements.filter((placement) =>
            rectanglesOverlap(rect, expandRect(placement.rect, 2)),
          ).length;
          const lineCollisions = ctx.edges.filter((other, index) => {
            if (index === edgeIndex) return false;
            return segmentIntersectsRect(edgeSegment(other, ctx), rect);
          }).length;
          candidates.push({
            edge: edgeIndex,
            rect,
            x,
            y,
            anchorX,
            anchorY,
            hardCollisions: nodeCollisions + labelCollisions,
            lineCollisions,
          });
        }
      }
    }
    candidates.sort(
      (a, b) =>
        a.hardCollisions - b.hardCollisions ||
        a.lineCollisions - b.lineCollisions ||
        Math.abs(a.x - a.anchorX) - Math.abs(b.x - b.anchorX) ||
        Math.abs(a.y - a.anchorY) - Math.abs(b.y - b.anchorY),
    );
    const best = candidates[0];
    placements.push(best);
    edge.labelX = best.x;
    edge.labelY = best.y;
    edge.labelAnchorX = best.anchorX;
    edge.labelAnchorY = best.anchorY;
  }
  return placements;
}

function collectViolations(
  ctx: LayoutContext,
  includeLabels = true,
): {
  messages: string[];
  placements: LabelPlacement[];
} {
  const messages: string[] = [];
  const add = (message: string) => {
    if (messages.length < 50) messages.push(message);
  };
  for (const axis of ["x", "y"] as const) {
    for (const nodes of ctx.alignments[axis]) {
      const coordinate = nodes[0][axis];
      if (nodes.some((node) => Math.abs(node[axis] - coordinate) > EPSILON)) {
        add(
          `alignment constraint ${axis} ${nodes.map((node) => node.id).join(" / ")}`,
        );
      }
    }
  }
  for (const constraint of ctx.constraints) {
    if (constraint.type === "near" || constraint.type === "align") continue;
    const aId = constraint.a ?? constraint.left ?? constraint.top;
    const bId = constraint.b ?? constraint.right ?? constraint.bottom;
    if (!aId || !bId) continue;
    const a = entityRect(ctx, aId);
    const b = entityRect(ctx, bId);
    if (!a || !b) continue;
    const correction = directionalCorrection(
      constraint.type,
      a,
      b,
      Math.max(ctx.options.minGap, ctx.options.nodeGap),
    );
    if (
      Math.abs(correction.dx) > EPSILON ||
      Math.abs(correction.dy) > EPSILON
    ) {
      add(`directional constraint ${aId} ${constraint.type} ${bId}`);
    }
  }

  const padding = ctx.options.nodeGap / 2;
  for (let first = 0; first < ctx.nodes.length; first++) {
    for (let second = first + 1; second < ctx.nodes.length; second++) {
      if (
        rectanglesOverlap(
          nodeRect(ctx.nodes[first], padding),
          nodeRect(ctx.nodes[second], padding),
        )
      ) {
        add(`node clearance ${ctx.nodes[first].id} / ${ctx.nodes[second].id}`);
      }
    }
  }

  const rects = allGroupRects(ctx);
  for (let first = 0; first < ctx.boundaries.length; first++) {
    for (let second = first + 1; second < ctx.boundaries.length; second++) {
      const a = ctx.boundaries[first];
      const b = ctx.boundaries[second];
      if (isAncestor(ctx, a.id, b.id) || isAncestor(ctx, b.id, a.id)) continue;
      const ar = rects.get(a.id);
      const br = rects.get(b.id);
      if (ar && br && rectanglesOverlap(ar, br)) {
        add(`group overlap ${a.id} / ${b.id}`);
      }
    }
  }
  for (const boundary of ctx.boundaries) {
    const rect = rects.get(boundary.id);
    if (!rect) continue;
    for (let index = 0; index < ctx.nodes.length; index++) {
      if (belongsTo(ctx, index, boundary.id)) continue;
      if (rectanglesOverlap(rect, nodeRect(ctx.nodes[index], padding))) {
        add(`node ${ctx.nodes[index].id} intersects group ${boundary.id}`);
      }
    }
  }

  for (const [edgeIndex, edge] of ctx.edges.entries()) {
    const [source, target] = edgeNodeIndices(edge, ctx);
    const segment = edgeSegment(edge, ctx);
    for (let index = 0; index < ctx.nodes.length; index++) {
      if (index === source || index === target) continue;
      if (
        segmentIntersectsRect(
          segment,
          nodeRect(ctx.nodes[index], NODE_EDGE_CLEARANCE),
        )
      ) {
        add(`edge ${edgeIndex + 1} intersects node ${ctx.nodes[index].id}`);
      }
    }
    for (const boundary of ctx.boundaries) {
      if (
        belongsTo(ctx, source, boundary.id) ||
        belongsTo(ctx, target, boundary.id)
      ) {
        continue;
      }
      const rect = rects.get(boundary.id);
      if (rect && segmentIntersectsRect(segment, rect)) {
        add(`edge ${edgeIndex + 1} intersects group ${boundary.id}`);
      }
    }
  }
  for (let first = 0; first < ctx.edges.length; first++) {
    const firstNodes = edgeNodeIndices(ctx.edges[first], ctx);
    for (let second = first + 1; second < ctx.edges.length; second++) {
      const secondNodes = edgeNodeIndices(ctx.edges[second], ctx);
      if (firstNodes.some((node) => secondNodes.includes(node))) continue;
      if (
        segmentsCross(
          edgeSegment(ctx.edges[first], ctx),
          edgeSegment(ctx.edges[second], ctx),
        )
      ) {
        add(`edges ${first + 1} and ${second + 1} cross`);
      }
    }
  }

  const placements =
    includeLabels && messages.length === 0 ? placeLabels(ctx) : [];
  if (includeLabels) {
    for (const placement of placements) {
      if (placement.hardCollisions > 0) {
        add(`label on edge ${placement.edge + 1} overlaps a node or label`);
      }
    }
  }
  return { messages, placements };
}

function makeContext(
  nodes: LayoutNode[],
  boundaries: LayoutBoundary[],
  edges: LayoutEdge[],
  constraints: LayoutConstraint[],
  options: LayoutOptions,
): LayoutContext {
  const boundaryById = new Map(
    boundaries.map((boundary) => [boundary.id, boundary]),
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const members = new Map<string, number[]>();
  for (const boundary of boundaries) members.set(boundary.id, []);
  for (const [index, node] of nodes.entries()) {
    let current = node.boundaryParent;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      members.get(current)?.push(index);
      seen.add(current);
      current = boundaryById.get(current)?.parent ?? null;
    }
  }
  const ctx: LayoutContext = {
    nodes,
    boundaries,
    edges,
    constraints,
    options,
    nodeById,
    nodeIndex: new Map(nodes.map((node, index) => [node, index])),
    boundaryById,
    members,
    alignments: { x: [], y: [] },
    maxDepth: 0,
  };
  ctx.alignments.x = alignmentComponents(ctx, "x");
  ctx.alignments.y = alignmentComponents(ctx, "y");
  ctx.maxDepth = boundaries.reduce(
    (maximum, boundary) => Math.max(maximum, boundaryDepth(ctx, boundary.id)),
    0,
  );
  return ctx;
}

function alignmentComponents(
  ctx: LayoutContext,
  axis: "x" | "y",
): LayoutNode[][] {
  const components: Array<Set<LayoutNode>> = [];
  for (const constraint of ctx.constraints) {
    if (constraint.type !== "align" || constraint.axis !== axis) continue;
    const nodes = nodesForEntities(ctx, constraint.ids ?? []);
    if (nodes.size < 2) continue;
    const connected = components.filter((component) =>
      [...nodes].some((node) => component.has(node)),
    );
    for (const component of connected) {
      for (const node of component) nodes.add(node);
      components.splice(components.indexOf(component), 1);
    }
    components.push(nodes);
  }
  return components.map((component) =>
    [...component].sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function captureSnapshot(
  ctx: LayoutContext,
  iteration: number,
  violations: number,
  placements: LabelPlacement[],
  phase: LayoutSnapshot["phase"] = "repair",
): LayoutSnapshot {
  const rects = allGroupRects(ctx);
  return {
    iteration,
    phase,
    violations,
    nodes: ctx.nodes.map(({ id, x, y, width, height }) => ({
      id,
      x,
      y,
      width,
      height,
    })),
    groups: ctx.boundaries.map((boundary) => ({
      id: boundary.id,
      rect: rects.get(boundary.id) ?? null,
    })),
    labels: placements.map((placement) => ({
      edge: placement.edge,
      text: ctx.edges[placement.edge].label ?? "",
      x: placement.x,
      y: placement.y,
      width: ctx.edges[placement.edge].labelWidth ?? 0,
      height: ctx.edges[placement.edge].labelHeight ?? 0,
    })),
  };
}

function measureLayout(ctx: LayoutContext): MinimizeMeasure | null {
  const check = collectViolations(ctx);
  if (check.messages.length > 0) return null;
  const groupRects = allGroupRects(ctx);
  const rects = [
    ...ctx.nodes.map((node) => nodeRect(node)),
    ...ctx.boundaries.flatMap((boundary) => {
      if (boundary.draw === false) return [];
      const rect = groupRects.get(boundary.id);
      return rect ? [rect] : [];
    }),
    ...check.placements.map((placement) => placement.rect),
  ];
  const edgeLength = ctx.edges.reduce((total, edge) => {
    const segment = edgeSegment(edge, ctx);
    return total + Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
  }, 0);
  return { rects, edgeLength };
}

function minimizationObstacles(ctx: LayoutContext): MinimizeObstacle[] {
  const groupRects = allGroupRects(ctx);
  return [
    ...ctx.nodes.map((node) => ({
      id: node.id,
      kind: "node" as const,
      rect: nodeRect(node),
      node,
    })),
    ...ctx.boundaries.flatMap((boundary) => {
      const rect = groupRects.get(boundary.id);
      return rect ? [{ id: boundary.id, kind: "boundary" as const, rect }] : [];
    }),
  ];
}

export function solveLayout(
  nodes: LayoutNode[],
  boundaries: LayoutBoundary[],
  edges: LayoutEdge[],
  constraints: LayoutConstraint[],
  options: LayoutOptions,
): LayoutResult {
  const ctx = makeContext(nodes, boundaries, edges, constraints, options);
  if (!options.preserveInitialPositions) initializeGrid(ctx);
  const snapshots: LayoutSnapshot[] = [];
  const every = Math.max(0, Math.floor(options.debugFrameEvery ?? 0));
  let check = collectViolations(ctx);
  if (every > 0) {
    snapshots.push(captureSnapshot(ctx, 0, check.messages.length, []));
  }
  let stable = 0;
  let iteration = 0;
  const stableTarget = Math.max(1, options.stableIterations ?? 3);
  for (iteration = 1; iteration <= options.iterations; iteration++) {
    resolveAlignmentConstraints(ctx);
    resolveDirectionalConstraints(ctx);
    resolveNodeOverlaps(ctx);
    resolveBoundaryOverlaps(ctx);
    resolveNodeEdgeIntersections(ctx);
    resolveEdgeBoundaryIntersections(ctx);
    resolveEdgeCrossings(ctx);
    resolveDirectionalConstraints(ctx);
    check = collectViolations(ctx);
    stable = check.messages.length === 0 ? stable + 1 : 0;
    if (every > 0 && iteration % every === 0) {
      snapshots.push(
        captureSnapshot(ctx, iteration, check.messages.length, []),
      );
    }
    if (stable >= stableTarget) break;
  }
  const completedIterations = Math.min(iteration, options.iterations);
  if (every > 0 && snapshots.at(-1)?.iteration !== completedIterations) {
    snapshots.push(
      captureSnapshot(ctx, completedIterations, check.messages.length, []),
    );
  }
  if (every > 0 && check.placements.length > 0) {
    snapshots.push(
      captureSnapshot(
        ctx,
        completedIterations,
        check.messages.length,
        check.placements,
        "labels",
      ),
    );
  }
  if (check.messages.length === 0) {
    const minimizeIterations = Math.max(
      0,
      Math.floor(options.minimizeIterations ?? 100),
    );
    const directEntityIds = (parent: string | null) => [
      ...ctx.nodes
        .filter((node) => node.boundaryParent === parent)
        .map((node) => node.id),
      ...ctx.boundaries
        .filter((boundary) => (boundary.parent ?? null) === parent)
        .map((boundary) => boundary.id),
    ];
    const minimizeEntityRect = (id: string) => {
      const node = ctx.nodeById.get(id);
      return node ? nodeRect(node) : rectFromMembers(ctx, id);
    };
    const minimizeRegionRect = (parent: string | null) =>
      parent === null
        ? boundsOfRects(
            directEntityIds(null).flatMap((id) => {
              const rect = minimizeEntityRect(id);
              return rect ? [rect] : [];
            }),
          )
        : rectFromMembers(ctx, parent);
    const drawnBoundaryIds = ctx.boundaries
      .filter((boundary) => boundary.draw !== false)
      .map((boundary) => boundary.id)
      .sort(
        (a, b) =>
          boundaryDepth(ctx, b) - boundaryDepth(ctx, a) || a.localeCompare(b),
      );
    const elementAlignmentContainerIds: Array<string | null> = [
      ...drawnBoundaryIds,
      null,
    ];
    const elementAreaScore = () =>
      drawnBoundaryIds.reduce((total, parent) => {
        const rect = minimizeRegionRect(parent);
        return rect
          ? total + (rect.maxX - rect.minX) * (rect.maxY - rect.minY)
          : total;
      }, 0);
    const setMinimizeEntityAxis = (
      id: string,
      axis: "x" | "y",
      value: number,
    ) => {
      const rect = minimizeEntityRect(id);
      if (!rect) return;
      const center =
        axis === "x"
          ? (rect.minX + rect.maxX) / 2
          : (rect.minY + rect.maxY) / 2;
      const delta = value - center;
      translateEntity(
        ctx,
        id,
        axis === "x" ? delta : 0,
        axis === "y" ? delta : 0,
      );
    };
    minimizeLayout({
      nodes: ctx.nodes,
      edges: ctx.edges.map((edge) => {
        const [source, target] = edgeNodeIndices(edge, ctx);
        return { source: ctx.nodes[source], target: ctx.nodes[target] };
      }),
      nodeGap: ctx.options.nodeGap,
      directionalGap: Math.max(ctx.options.minGap, ctx.options.nodeGap),
      directions: ctx.constraints.flatMap((constraint) => {
        const a = constraint.a ?? constraint.left ?? constraint.top;
        const b = constraint.b ?? constraint.right ?? constraint.bottom;
        return a && b ? [{ type: constraint.type, a, b }] : [];
      }),
      generations: minimizeIterations,
      setNodeAxis: (node, axis, value) => {
        const delta = value - node[axis];
        if (Math.abs(delta) <= EPSILON) return;
        const dx = axis === "x" ? delta : 0;
        const dy = axis === "y" ? delta : 0;
        translateEntities(ctx, [node.id], dx, dy);
      },
      containerIds: ctx.boundaries
        .filter((boundary) => !boundary.parent)
        .map((boundary) => boundary.id),
      swappableContainerIds: ctx.boundaries.map((boundary) => boundary.id),
      containerParent: (id) => ctx.boundaryById.get(id)?.parent ?? null,
      containerRect: (id) => rectFromMembers(ctx, id),
      setContainerAxis: (id, axis, value) => {
        const rect = rectFromMembers(ctx, id);
        if (!rect) return;
        const center =
          axis === "x"
            ? (rect.minX + rect.maxX) / 2
            : (rect.minY + rect.maxY) / 2;
        const delta = value - center;
        translateEntity(
          ctx,
          id,
          axis === "x" ? delta : 0,
          axis === "y" ? delta : 0,
        );
      },
      ...(drawnBoundaryIds.length > 0
        ? {
            elementAlignmentContainerIds,
            childEntityIds: directEntityIds,
            isBoundaryEntity: (id: string) => ctx.boundaryById.has(id),
            entityRect: minimizeEntityRect,
            setEntityAxis: setMinimizeEntityAxis,
            regionRect: minimizeRegionRect,
            elementAreaScore,
          }
        : {}),
      obstacles: () => minimizationObstacles(ctx),
      isValid: (includeLabels) =>
        collectViolations(ctx, includeLabels).messages.length === 0,
      measure: () => measureLayout(ctx),
    });
    check = collectViolations(ctx);
  }
  if (every > 0) {
    const finalSnapshot = captureSnapshot(
      ctx,
      completedIterations,
      check.messages.length,
      check.placements,
      "final",
    );
    snapshots.push(finalSnapshot);
  }
  return {
    valid: check.messages.length === 0,
    iterations: completedIterations,
    violations: check.messages,
    groups: allGroupRects(ctx),
    snapshots,
  };
}
