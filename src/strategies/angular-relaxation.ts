import type { LayoutNode } from "../layout";
import {
  compactness,
  emitIteration,
  EPSILON,
  expandRect,
  measureBounds,
  nodeRect,
  rectanglesOverlap,
  restore,
  setNodeAxis,
  snapshot,
} from "./shared";
import type { MinimizeEdge, MinimizeOptions } from "./types";

const FULL_TURN = Math.PI * 2;
const MINIMUM_ANGULAR_GAP = (40 * Math.PI) / 180;
// One completely collapsed angular gap is worth this many node gaps of edge
// length. Beyond that, aggregate crowding scales superlinearly: layouts with
// several unresolved gaps should spend more edge length on readability, while
// an otherwise open layout keeps the lower ratio.
const ANGULAR_ERROR_EDGE_EQUIVALENT = 0.25;
const DENSE_CROWDING_PRESSURE = 4.5;
const ANGULAR_NUDGE_EPSILON = 1e-4;
const NUDGE_FRACTIONS = [
  1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625,
] as const;

type NeighborMap = Map<LayoutNode, LayoutNode[]>;

function hasNodeClearanceViolation(options: MinimizeOptions): boolean {
  const padding = options.nodeGap / 2;
  const rects = options.nodes.map((node) =>
    expandRect(nodeRect(node), padding),
  );
  for (let first = 0; first < rects.length; first++) {
    for (let second = first + 1; second < rects.length; second++) {
      if (rectanglesOverlap(rects[first], rects[second])) return true;
    }
  }
  return false;
}

function normalizedAngle(angle: number): number {
  return ((angle % FULL_TURN) + FULL_TURN) % FULL_TURN;
}

function signedAngleDifference(from: number, to: number): number {
  let difference = normalizedAngle(to) - normalizedAngle(from);
  if (difference > Math.PI) difference -= FULL_TURN;
  if (difference < -Math.PI) difference += FULL_TURN;
  return difference;
}

function buildNeighborMap(edges: MinimizeEdge[]): NeighborMap {
  const connected = new Map<LayoutNode, Set<LayoutNode>>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const sourceNeighbors = connected.get(edge.source) ?? new Set<LayoutNode>();
    sourceNeighbors.add(edge.target);
    connected.set(edge.source, sourceNeighbors);
    const targetNeighbors = connected.get(edge.target) ?? new Set<LayoutNode>();
    targetNeighbors.add(edge.source);
    connected.set(edge.target, targetNeighbors);
  }
  return new Map(
    [...connected].map(([hub, neighbors]) => [
      hub,
      [...neighbors].sort((a, b) => a.id.localeCompare(b.id)),
    ]),
  );
}

function angularGapError(angles: number[]): number {
  if (angles.length < 2) return 0;
  const ordered = angles.map(normalizedAngle).sort((a, b) => a - b);
  let error = 0;
  for (let index = 0; index < ordered.length; index++) {
    const next = ordered[(index + 1) % ordered.length];
    const gap = normalizedAngle(next - ordered[index]);
    if (gap >= MINIMUM_ANGULAR_GAP) continue;
    const shortage = (MINIMUM_ANGULAR_GAP - gap) / MINIMUM_ANGULAR_GAP;
    error += shortage * shortage;
  }
  return error;
}

function hubAngularError(hub: LayoutNode, neighbors: LayoutNode[]): number {
  return angularGapError(
    neighbors.map((neighbor) =>
      Math.atan2(neighbor.y - hub.y, neighbor.x - hub.x),
    ),
  );
}

function totalAngularError(neighborsByHub: NeighborMap): number {
  let error = 0;
  for (const [hub, neighbors] of neighborsByHub) {
    error += hubAngularError(hub, neighbors);
  }
  return error;
}

function sharedHubCrowdingPressure(neighborsByHub: NeighborMap): number {
  let error = 0;
  let count = 0;
  for (const [hub, neighbors] of neighborsByHub) {
    if (neighbors.length < 3) continue;
    const angles = neighbors
      .map((neighbor) =>
        normalizedAngle(Math.atan2(neighbor.y - hub.y, neighbor.x - hub.x)),
      )
      .sort((a, b) => a - b);
    if (angles.length < 2) continue;
    for (let index = 0; index < angles.length; index++) {
      const next = angles[(index + 1) % angles.length];
      if (
        normalizedAngle(next - angles[index]) <
        MINIMUM_ANGULAR_GAP - ANGULAR_NUDGE_EPSILON
      ) {
        count++;
      }
    }
    error += hubAngularError(hub, neighbors);
  }
  return error * count;
}

function obstacleArea(options: MinimizeOptions): number {
  const bounds = measureBounds(
    options.obstacles().map((obstacle) => obstacle.rect),
  );
  return bounds ? (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY) : 0;
}

export function angularRelaxationScore(edges: MinimizeEdge[]): number {
  return totalAngularError(buildNeighborMap(edges));
}

export function readabilityCost(
  edgeLength: number,
  angularError: number,
  nodeGap: number,
  angularWeight: number,
): number {
  return edgeLength + angularError * nodeGap * angularWeight;
}

function readabilityWeight(neighborsByHub: NeighborMap): number {
  const crowdingPressure = sharedHubCrowdingPressure(neighborsByHub);
  return (
    ANGULAR_ERROR_EDGE_EQUIVALENT *
    Math.max(1, (crowdingPressure / DENSE_CROWDING_PRESSURE) ** 6)
  );
}

export function angularReadabilityWeight(edges: MinimizeEdge[]): number {
  return readabilityWeight(buildNeighborMap(edges));
}

function targetAngle(
  hub: LayoutNode,
  neighbor: LayoutNode,
  connected: LayoutNode[],
): number | null {
  const ordered = connected
    .map((candidate) => ({
      node: candidate,
      angle: normalizedAngle(
        Math.atan2(candidate.y - hub.y, candidate.x - hub.x),
      ),
    }))
    .sort(
      (first, second) =>
        first.angle - second.angle ||
        first.node.id.localeCompare(second.node.id),
    );
  const index = ordered.findIndex((candidate) => candidate.node === neighbor);
  const previous = ordered[(index - 1 + ordered.length) % ordered.length].angle;
  const current = ordered[index].angle;
  const next = ordered[(index + 1) % ordered.length].angle;
  const targets: number[] = [];
  const previousGap = normalizedAngle(current - previous);
  const nextGap = normalizedAngle(next - current);
  if (previousGap < MINIMUM_ANGULAR_GAP) {
    const adjustment = MINIMUM_ANGULAR_GAP - previousGap;
    if (nextGap >= MINIMUM_ANGULAR_GAP + adjustment) {
      targets.push(normalizedAngle(current + adjustment));
    }
  }
  if (nextGap < MINIMUM_ANGULAR_GAP) {
    const adjustment = MINIMUM_ANGULAR_GAP - nextGap;
    if (previousGap >= MINIMUM_ANGULAR_GAP + adjustment) {
      targets.push(normalizedAngle(current - adjustment));
    }
  }
  if (targets.length === 0) return null;
  return targets.reduce((closest, target) =>
    Math.abs(signedAngleDifference(current, target)) <
    Math.abs(signedAngleDifference(current, closest))
      ? target
      : closest,
  );
}

function hasCrowdedGap(
  hub: LayoutNode,
  neighbor: LayoutNode,
  connected: LayoutNode[],
): boolean {
  const ordered = connected
    .map((candidate) => ({
      node: candidate,
      angle: normalizedAngle(
        Math.atan2(candidate.y - hub.y, candidate.x - hub.x),
      ),
    }))
    .sort(
      (first, second) =>
        first.angle - second.angle ||
        first.node.id.localeCompare(second.node.id),
    );
  const index = ordered.findIndex((candidate) => candidate.node === neighbor);
  const previous = ordered[(index - 1 + ordered.length) % ordered.length].angle;
  const current = ordered[index].angle;
  const next = ordered[(index + 1) % ordered.length].angle;
  return (
    normalizedAngle(current - previous) <
      MINIMUM_ANGULAR_GAP - ANGULAR_NUDGE_EPSILON ||
    normalizedAngle(next - current) <
      MINIMUM_ANGULAR_GAP - ANGULAR_NUDGE_EPSILON
  );
}

function tryRelaxNeighbor(
  options: MinimizeOptions,
  neighborsByHub: NeighborMap,
  hub: LayoutNode,
  neighbor: LayoutNode,
  connected: LayoutNode[],
  baselineError: number,
  maximumArea: number,
): number | null {
  const dx = neighbor.x - hub.x;
  const dy = neighbor.y - hub.y;
  const radius = Math.hypot(dx, dy);
  if (radius <= EPSILON) return null;
  const originalAngle = Math.atan2(dy, dx);
  const originalPositions = snapshot(options.nodes);
  const originalX = neighbor.x;
  const originalY = neighbor.y;

  const target = targetAngle(hub, neighbor, connected);
  if (target === null) return null;
  const delta = signedAngleDifference(originalAngle, target);
  const maximumAngularAdjustment = Math.abs(delta) + ANGULAR_NUDGE_EPSILON;
  const targetX = hub.x + Math.cos(target) * radius;
  const targetY = hub.y + Math.sin(target) * radius;
  const baselineMeasure = options.measure();
  if (!baselineMeasure) return null;
  const angularWeight = readabilityWeight(neighborsByHub);
  let bestError = baselineError;
  let bestReadability = readabilityCost(
    baselineMeasure.edgeLength,
    baselineError,
    options.nodeGap,
    angularWeight,
  );
  let bestPositions: ReturnType<typeof snapshot> | null = null;
  for (const fraction of NUDGE_FRACTIONS) {
    const candidateAngle = originalAngle + delta * fraction;
    for (const candidate of [
      {
        x: hub.x + Math.cos(candidateAngle) * radius,
        y: hub.y + Math.sin(candidateAngle) * radius,
      },
      {
        x: hub.x + Math.cos(candidateAngle) * radius * (1 - fraction),
        y: hub.y + Math.sin(candidateAngle) * radius * (1 - fraction),
      },
      { x: neighbor.x + (targetX - neighbor.x) * fraction },
      { y: neighbor.y + (targetY - neighbor.y) * fraction },
      {
        x: neighbor.x + (hub.x - neighbor.x) * fraction,
        y: neighbor.y + (hub.y - neighbor.y) * fraction,
      },
    ]) {
      restore(options.nodes, originalPositions);
      if (candidate.x !== undefined) {
        setNodeAxis(options, neighbor, "x", candidate.x);
      }
      if (candidate.y !== undefined) {
        setNodeAxis(options, neighbor, "y", candidate.y);
      }
      if (
        Math.hypot(neighbor.x - originalX, neighbor.y - originalY) >
        options.nodeGap + EPSILON
      ) {
        continue;
      }
      const candidateAngle = Math.atan2(neighbor.y - hub.y, neighbor.x - hub.x);
      if (
        Math.abs(signedAngleDifference(originalAngle, candidateAngle)) >
        maximumAngularAdjustment
      ) {
        continue;
      }
      if (hasNodeClearanceViolation(options) || !options.isValid(false)) {
        continue;
      }
      if (obstacleArea(options) > maximumArea + EPSILON) continue;
      const candidateError = totalAngularError(neighborsByHub);
      if (candidateError >= baselineError - ANGULAR_NUDGE_EPSILON) continue;
      const candidateMeasure = options.measure();
      if (!candidateMeasure) continue;
      const candidateReadability = readabilityCost(
        candidateMeasure.edgeLength,
        candidateError,
        options.nodeGap,
        angularWeight,
      );
      if (candidateReadability < bestReadability - EPSILON) {
        bestError = candidateError;
        bestReadability = candidateReadability;
        bestPositions = snapshot(options.nodes);
      }
    }
  }

  restore(options.nodes, bestPositions ?? originalPositions);
  return bestPositions ? bestError : null;
}

export function minimizeAngularRelaxation(
  options: MinimizeOptions,
  maximumArea: number,
): boolean {
  const neighborsByHub = buildNeighborMap(options.edges);
  let angularError = totalAngularError(neighborsByHub);
  let changed = false;
  const maxGenerations = Math.min(10, Math.max(0, options.generations));

  for (let generation = 0; generation < maxGenerations; generation++) {
    if (angularError <= ANGULAR_NUDGE_EPSILON) break;
    const baselinePositions = snapshot(options.nodes);
    const baselineError = angularError;
    let moved = false;
    for (const [hub, connected] of [...neighborsByHub].sort((a, b) =>
      a[0].id.localeCompare(b[0].id),
    )) {
      if (connected.length < 2) continue;
      for (const neighbor of connected) {
        if (!hasCrowdedGap(hub, neighbor, connected)) continue;
        const candidateError = tryRelaxNeighbor(
          options,
          neighborsByHub,
          hub,
          neighbor,
          connected,
          angularError,
          maximumArea,
        );
        if (candidateError === null) continue;
        angularError = candidateError;
        moved = true;
      }
    }
    if (!moved) break;
    const candidateMeasure = options.measure();
    if (
      !candidateMeasure ||
      compactness(candidateMeasure).area > maximumArea + EPSILON
    ) {
      restore(options.nodes, baselinePositions);
      angularError = baselineError;
      break;
    }
    changed = true;
    emitIteration(options, "angular-relaxation", generation + 1);
  }
  return changed;
}
