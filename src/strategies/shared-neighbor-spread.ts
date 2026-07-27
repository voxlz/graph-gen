import type { LayoutNode } from "../layout";
import {
  compactness,
  compareByKeys,
  emitIteration,
  EPSILON,
  expandRect,
  nodeRect,
  rectanglesOverlap,
  restore,
  snapshot,
} from "./shared";
import type { MinimizeDirection, MinimizeOptions } from "./types";

interface DirectionSigns {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}

function directionSigns(type: string): DirectionSigns | null {
  switch (type.toLowerCase()) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    case "topleft":
      return { x: -1, y: -1 };
    case "topright":
      return { x: 1, y: -1 };
    case "bottomleft":
      return { x: -1, y: 1 };
    case "bottomright":
      return { x: 1, y: 1 };
    default:
      return null;
  }
}

function neighborDirection(
  hub: LayoutNode,
  neighbor: LayoutNode,
  directions: MinimizeDirection[],
): DirectionSigns | null {
  for (const direction of directions) {
    const signs = directionSigns(direction.type);
    if (!signs) continue;
    if (direction.a === neighbor.id && direction.b === hub.id) return signs;
    if (direction.a === hub.id && direction.b === neighbor.id) {
      return {
        x: -signs.x as DirectionSigns["x"],
        y: -signs.y as DirectionSigns["y"],
      };
    }
  }
  return null;
}

function normalizedAngle(angle: number): number {
  const fullTurn = Math.PI * 2;
  return ((angle % fullTurn) + fullTurn) % fullTurn;
}

function signedAngleDifference(from: number, to: number): number {
  let difference = normalizedAngle(to) - normalizedAngle(from);
  if (difference > Math.PI) difference -= Math.PI * 2;
  if (difference < -Math.PI) difference += Math.PI * 2;
  return difference;
}

function positionAt(
  node: LayoutNode,
  hub: LayoutNode,
  radius: number,
  angle: number,
): LayoutNode {
  return {
    ...node,
    x: hub.x + Math.cos(angle) * radius,
    y: hub.y + Math.sin(angle) * radius,
  };
}

function blockedAtEqualRadius(
  hub: LayoutNode,
  first: LayoutNode,
  second: LayoutNode,
  nodeGap: number,
): boolean {
  const firstRadius = Math.hypot(first.x - hub.x, first.y - hub.y);
  const secondRadius = Math.hypot(second.x - hub.x, second.y - hub.y);
  if (Math.abs(firstRadius - secondRadius) <= EPSILON) return false;
  const radius = Math.min(firstRadius, secondRadius);
  const projectedFirst = positionAt(
    first,
    hub,
    radius,
    Math.atan2(first.y - hub.y, first.x - hub.x),
  );
  const projectedSecond = positionAt(
    second,
    hub,
    radius,
    Math.atan2(second.y - hub.y, second.x - hub.x),
  );
  return rectanglesOverlap(
    expandRect(nodeRect(projectedFirst), nodeGap / 2),
    expandRect(nodeRect(projectedSecond), nodeGap / 2),
  );
}

function requiredRadius(
  hub: LayoutNode,
  neighbor: LayoutNode,
  angle: number,
  nodeGap: number,
  directionalGap: number,
  direction: DirectionSigns | null,
): number {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const xClearance = hub.width / 2 + neighbor.width / 2;
  const yClearance = hub.height / 2 + neighbor.height / 2;
  if (!direction) {
    return Math.min(
      (xClearance + nodeGap) / Math.max(Math.abs(cosine), EPSILON),
      (yClearance + nodeGap) / Math.max(Math.abs(sine), EPSILON),
    );
  }
  if (
    (direction.x !== 0 && Math.sign(cosine) !== direction.x) ||
    (direction.y !== 0 && Math.sign(sine) !== direction.y)
  ) {
    return Infinity;
  }
  const requirements = [];
  if (direction.x !== 0) {
    requirements.push(
      (xClearance + directionalGap) / Math.max(Math.abs(cosine), EPSILON),
    );
  }
  if (direction.y !== 0) {
    requirements.push(
      (yClearance + directionalGap) / Math.max(Math.abs(sine), EPSILON),
    );
  }
  return Math.max(...requirements);
}

function bisectorCandidates(firstAngle: number, secondAngle: number): number[] {
  const bisector =
    firstAngle + signedAngleDifference(firstAngle, secondAngle) / 2;
  const candidates = new Set<number>();
  for (let offset = -45; offset <= 45; offset += 5) {
    candidates.add(normalizedAngle(bisector + (offset * Math.PI) / 180));
  }
  return [...candidates].sort((a, b) => a - b);
}

export function minimizeSharedNeighborSpread(
  options: MinimizeOptions,
  maximumArea: number,
): boolean {
  const directions = options.directions ?? [];
  const neighbors = new Map<LayoutNode, Set<LayoutNode>>();
  for (const edge of options.edges) {
    const sourceNeighbors = neighbors.get(edge.source) ?? new Set<LayoutNode>();
    sourceNeighbors.add(edge.target);
    neighbors.set(edge.source, sourceNeighbors);
    const targetNeighbors = neighbors.get(edge.target) ?? new Set<LayoutNode>();
    targetNeighbors.add(edge.source);
    neighbors.set(edge.target, targetNeighbors);
  }

  let changed = false;
  const maxGenerations = Math.min(3, Math.max(0, options.generations));
  for (let generation = 0; generation < maxGenerations; generation++) {
    const baselineMeasure = options.measure();
    if (!baselineMeasure) return changed;
    const baselineScore = compactness(baselineMeasure);
    const baselinePositions = snapshot(options.nodes);
    let bestScore = baselineScore;
    let bestPositions: ReturnType<typeof snapshot> | null = null;

    for (const [hub, connected] of [...neighbors.entries()].sort((a, b) =>
      a[0].id.localeCompare(b[0].id),
    )) {
      const siblings = [...connected]
        .filter((node) => node.boundaryParent === hub.boundaryParent)
        .sort((a, b) => a.id.localeCompare(b.id));
      for (let firstIndex = 0; firstIndex < siblings.length; firstIndex++) {
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < siblings.length;
          secondIndex++
        ) {
          const first = siblings[firstIndex];
          const second = siblings[secondIndex];
          if (!blockedAtEqualRadius(hub, first, second, options.nodeGap)) {
            continue;
          }
          const firstAngle = Math.atan2(first.y - hub.y, first.x - hub.x);
          const secondAngle = Math.atan2(second.y - hub.y, second.x - hub.x);
          const firstDirection = neighborDirection(hub, first, directions);
          const secondDirection = neighborDirection(hub, second, directions);
          const directionalGap = options.directionalGap ?? options.nodeGap;
          for (const bisector of bisectorCandidates(firstAngle, secondAngle)) {
            for (let separation = 5; separation <= 120; separation += 5) {
              const halfSeparation = (separation * Math.PI) / 360;
              for (const order of [-1, 1]) {
                const candidateFirstAngle = bisector + order * halfSeparation;
                const candidateSecondAngle = bisector - order * halfSeparation;
                const radius = Math.max(
                  requiredRadius(
                    hub,
                    first,
                    candidateFirstAngle,
                    options.nodeGap,
                    directionalGap,
                    firstDirection,
                  ),
                  requiredRadius(
                    hub,
                    second,
                    candidateSecondAngle,
                    options.nodeGap,
                    directionalGap,
                    secondDirection,
                  ),
                );
                if (!Number.isFinite(radius)) continue;
                restore(options.nodes, baselinePositions);
                first.x = hub.x + Math.cos(candidateFirstAngle) * radius;
                first.y = hub.y + Math.sin(candidateFirstAngle) * radius;
                second.x = hub.x + Math.cos(candidateSecondAngle) * radius;
                second.y = hub.y + Math.sin(candidateSecondAngle) * radius;
                const candidateMeasure = options.measure();
                if (!candidateMeasure) continue;
                const candidateScore = compactness(candidateMeasure);
                if (
                  candidateScore.area <= maximumArea + EPSILON &&
                  compareByKeys(candidateScore, bestScore, [
                    "edgeLength",
                    "area",
                    "perimeter",
                    "largestDimension",
                  ]) < 0
                ) {
                  bestScore = candidateScore;
                  bestPositions = snapshot(options.nodes);
                }
              }
            }
          }
        }
      }
    }

    restore(options.nodes, bestPositions ?? baselinePositions);
    if (!bestPositions) break;
    changed = true;
    emitIteration(options, "shared-neighbor-spread", generation + 1);
  }
  return changed;
}
