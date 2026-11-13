import type { LayoutNode } from "../layout";
import {
  compactness,
  emitIteration,
  EPSILON,
  restore,
  setNodeAxis,
  snapshot,
} from "./shared";
import type { MinimizeOptions } from "./types";

const REPAIR_PASSES = 4;

interface Point {
  x: number;
  y: number;
}

// Area and edge length are each normalised by their value when the stage
// starts, so a move may trade a little of one for a larger gain in the other.
function relocationCost(
  options: MinimizeOptions,
  baseline: { area: number; edgeLength: number },
): number | null {
  const measure = options.measure();
  if (!measure) return null;
  const score = compactness(measure);
  return (
    score.area / Math.max(baseline.area, 1) +
    score.edgeLength / Math.max(baseline.edgeLength, 1)
  );
}

function neighborsOf(options: MinimizeOptions): Map<LayoutNode, LayoutNode[]> {
  const neighbors = new Map<LayoutNode, LayoutNode[]>();
  for (const edge of options.edges) {
    if (edge.source === edge.target) continue;
    for (const [node, other] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ] as const) {
      const list = neighbors.get(node) ?? [];
      if (!list.includes(other)) list.push(other);
      neighbors.set(node, list);
    }
  }
  return neighbors;
}

interface Candidate extends Point {
  // Hole-filling candidates pull an outlying node into its group's interior;
  // they may not shorten the node's own edges but shrink the group.
  fillsHole: boolean;
}

function neighborSlots(
  options: MinimizeOptions,
  node: LayoutNode,
  neighbors: LayoutNode[],
): Candidate[] {
  if (neighbors.length === 0) return [];
  const points: Candidate[] = [];
  const barycenter = {
    x: neighbors.reduce((sum, other) => sum + other.x, 0) / neighbors.length,
    y: neighbors.reduce((sum, other) => sum + other.y, 0) / neighbors.length,
  };
  points.push(
    { ...barycenter, fillsHole: false },
    {
      x: (node.x + barycenter.x) / 2,
      y: (node.y + barycenter.y) / 2,
      fillsHole: false,
    },
  );
  const gap = Math.max(options.nodeGap, options.directionalGap ?? 0);
  for (const other of neighbors) {
    const dx = (node.width + other.width) / 2 + gap;
    const dy = (node.height + other.height) / 2 + gap;
    points.push(
      { x: other.x - dx, y: other.y, fillsHole: false },
      { x: other.x + dx, y: other.y, fillsHole: false },
      { x: other.x, y: other.y - dy, fillsHole: false },
      { x: other.x, y: other.y + dy, fillsHole: false },
    );
  }
  return points;
}

// Free slots inside the bounds of a node's siblings: in line with a sibling's
// row or column, or directly beside it. Only offered to nodes on the outside of
// their group, since only those can shrink it by moving inwards.
function holeSlots(options: MinimizeOptions, node: LayoutNode): Candidate[] {
  const siblings = options.nodes.filter(
    (other) => other !== node && other.boundaryParent === node.boundaryParent,
  );
  if (siblings.length === 0) return [];
  const bounds = {
    minX: Math.min(...siblings.map((n) => n.x - n.width / 2)),
    maxX: Math.max(...siblings.map((n) => n.x + n.width / 2)),
    minY: Math.min(...siblings.map((n) => n.y - n.height / 2)),
    maxY: Math.max(...siblings.map((n) => n.y + n.height / 2)),
  };
  const outlying =
    node.x - node.width / 2 < bounds.minX - EPSILON ||
    node.x + node.width / 2 > bounds.maxX + EPSILON ||
    node.y - node.height / 2 < bounds.minY - EPSILON ||
    node.y + node.height / 2 > bounds.maxY + EPSILON;
  if (!outlying) return [];
  const pad = options.nodeGap / 2;
  const free = (point: Point) =>
    point.x >= bounds.minX - EPSILON &&
    point.x <= bounds.maxX + EPSILON &&
    point.y >= bounds.minY - EPSILON &&
    point.y <= bounds.maxY + EPSILON &&
    options.nodes.every(
      (other) =>
        other === node ||
        Math.abs(other.x - point.x) >=
          (other.width + node.width) / 2 + 2 * pad - EPSILON ||
        Math.abs(other.y - point.y) >=
          (other.height + node.height) / 2 + 2 * pad - EPSILON,
    );
  const points: Candidate[] = [];
  const gap = options.nodeGap;
  for (const other of siblings) {
    const dx = (node.width + other.width) / 2 + gap;
    const dy = (node.height + other.height) / 2 + gap;
    // In line with the sibling, plus small nudges along that line so the moved
    // node's edges can clear the nodes it now sits beside.
    const nudges = [0, 0.25, -0.25, 0.5, -0.5, 1, -1];
    for (const point of [
      ...nudges.map((f) => ({ x: other.x + f * node.width, y: node.y })),
      ...nudges.map((f) => ({ x: node.x, y: other.y + f * node.height })),
      { x: other.x - dx, y: other.y },
      { x: other.x + dx, y: other.y },
      { x: other.x, y: other.y - dy },
      { x: other.x, y: other.y + dy },
    ]) {
      if (free(point)) points.push({ ...point, fillsHole: true });
    }
  }
  return points;
}

function candidatePositions(
  options: MinimizeOptions,
  node: LayoutNode,
  neighbors: LayoutNode[],
): Candidate[] {
  const seen = new Set<string>();
  return [
    ...holeSlots(options, node),
    ...neighborSlots(options, node, neighbors),
  ].filter((point) => {
    const key = `${point.x.toFixed(1)}:${point.y.toFixed(1)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return (
      Math.abs(point.x - node.x) > EPSILON ||
      Math.abs(point.y - node.y) > EPSILON
    );
  });
}

export function minimizeRelocation(options: MinimizeOptions): boolean {
  const neighbors = neighborsOf(options);
  const initial = options.measure();
  if (!initial) return false;
  const baseline = compactness(initial);
  let currentCost = relocationCost(options, baseline);
  if (currentCost === null) return false;

  let changed = false;
  const maxGenerations = Math.min(4, Math.max(0, options.generations));
  for (let generation = 0; generation < maxGenerations; generation++) {
    let moved = false;
    const ordered = [...options.nodes].sort((a, b) => a.id.localeCompare(b.id));
    for (const node of ordered) {
      const original = snapshot(options.nodes);
      let bestCost: number = currentCost;
      let bestPositions: ReturnType<typeof snapshot> | null = null;
      const adjacent = neighbors.get(node) ?? [];
      const incidentLength = (x: number, y: number) =>
        adjacent.reduce(
          (sum, other) => sum + Math.hypot(other.x - x, other.y - y),
          0,
        );
      const currentLength = incidentLength(node.x, node.y);
      for (const point of candidatePositions(options, node, adjacent)) {
        // Cheap prefilter before the expensive validate/repair/measure cycle.
        if (
          !point.fillsHole &&
          incidentLength(point.x, point.y) >= currentLength - EPSILON
        ) {
          continue;
        }
        restore(options.nodes, original);
        setNodeAxis(options, node, "x", point.x);
        setNodeAxis(options, node, "y", point.y);
        // Repair tends to undo a hole fill by pushing the node back out, so
        // those candidates (which include nudged variants) must be valid as is.
        if (
          !options.isValid(true) &&
          (point.fillsHole || !options.repair?.(REPAIR_PASSES))
        ) {
          continue;
        }
        const cost = relocationCost(options, baseline);
        if (cost !== null && cost < bestCost - 1e-4) {
          bestCost = cost;
          bestPositions = snapshot(options.nodes);
        }
      }
      restore(options.nodes, bestPositions ?? original);
      if (bestPositions) {
        currentCost = bestCost;
        moved = true;
      }
    }
    if (!moved) break;
    changed = true;
    emitIteration(options, "relocation", generation + 1);
  }
  return changed;
}
