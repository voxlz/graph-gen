import type { LayoutNode } from "../layout";
import {
  compactness,
  emitIteration,
  EPSILON,
  restore,
  snapshot,
} from "./shared";
import type { MinimizeOptions } from "./types";

interface PositionCandidate {
  node: LayoutNode;
  x: number;
  y: number;
  key: string;
}

function perimeterCandidates(
  options: MinimizeOptions,
  node: LayoutNode,
): PositionCandidate[] {
  const candidates = new Map<string, PositionCandidate>();
  const peers = options.nodes.filter(
    (other) => other !== node && other.boundaryParent === node.boundaryParent,
  );
  for (const obstacle of options.obstacles()) {
    if (obstacle.node === node) continue;
    const clearance =
      obstacle.kind === "boundary" ? options.nodeGap / 2 : options.nodeGap;
    const horizontalSlots = [
      (obstacle.rect.minX + obstacle.rect.maxX) / 2,
      ...peers.flatMap((peer) => [
        peer.x,
        peer.x - peer.width / 2 - node.width / 2 - options.nodeGap,
        peer.x + peer.width / 2 + node.width / 2 + options.nodeGap,
      ]),
    ];
    const verticalSlots = [
      (obstacle.rect.minY + obstacle.rect.maxY) / 2,
      ...peers.flatMap((peer) => [
        peer.y,
        peer.y - peer.height / 2 - node.height / 2 - options.nodeGap,
        peer.y + peer.height / 2 + node.height / 2 + options.nodeGap,
      ]),
    ];
    const top = obstacle.rect.minY - node.height / 2 - clearance;
    const bottom = obstacle.rect.maxY + node.height / 2 + clearance;
    const left = obstacle.rect.minX - node.width / 2 - clearance;
    const right = obstacle.rect.maxX + node.width / 2 + clearance;
    for (const x of horizontalSlots) {
      for (const y of [top, bottom]) {
        const key = `${node.id}:${x.toFixed(3)}:${y.toFixed(3)}`;
        candidates.set(key, { node, x, y, key });
      }
    }
    for (const y of verticalSlots) {
      for (const x of [left, right]) {
        const key = `${node.id}:${x.toFixed(3)}:${y.toFixed(3)}`;
        candidates.set(key, { node, x, y, key });
      }
    }
  }
  return [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function minimizeDisconnectedPerimeter(
  options: MinimizeOptions,
  maximumArea: number,
): boolean {
  const connected = new Set<LayoutNode>();
  for (const edge of options.edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  const disconnected = options.nodes
    .filter((node) => !connected.has(node))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (disconnected.length === 0) return false;

  const baselineMeasure = options.measure();
  if (!baselineMeasure) return false;
  const baselinePositions = snapshot(options.nodes);
  let bestScore = compactness(baselineMeasure);
  let bestPositions: ReturnType<typeof snapshot> | null = null;

  for (const node of disconnected) {
    for (const candidate of perimeterCandidates(options, node)) {
      restore(options.nodes, baselinePositions);
      candidate.node.x = candidate.x;
      candidate.node.y = candidate.y;
      const candidateMeasure = options.measure();
      if (!candidateMeasure) continue;
      const candidateScore = compactness(candidateMeasure);
      if (
        candidateScore.area <= maximumArea + EPSILON &&
        (candidateScore.area < bestScore.area - EPSILON ||
          (Math.abs(candidateScore.area - bestScore.area) <= EPSILON &&
            (candidateScore.perimeter < bestScore.perimeter - EPSILON ||
              (Math.abs(candidateScore.perimeter - bestScore.perimeter) <=
                EPSILON &&
                candidateScore.largestDimension <
                  bestScore.largestDimension - EPSILON))))
      ) {
        bestScore = candidateScore;
        bestPositions = snapshot(options.nodes);
      }
    }
  }

  restore(options.nodes, bestPositions ?? baselinePositions);
  if (!bestPositions) return false;
  emitIteration(options, "disconnected-perimeter", 1);
  return true;
}
