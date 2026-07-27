import type { LayoutNode } from "../layout";
import {
  compactness,
  emitIteration,
  EPSILON,
  restore,
  snapshot,
} from "./shared";
import type { MinimizeOptions } from "./types";

export function minimizeNodeSwaps(
  options: MinimizeOptions,
  maximumArea: number,
): boolean {
  const drawnBoundaries = new Set(options.drawnContainerIds ?? []);
  const inDrawnBoundary = (node: LayoutNode): boolean =>
    node.boundaryParent !== null && drawnBoundaries.has(node.boundaryParent);
  // Container peers may always trade places. A cross-container swap reshapes
  // both containers, so it is only offered when neither side sits in a drawn
  // boundary; undrawn groups and the root level carry no box to distort.
  const canSwap = (a: LayoutNode, b: LayoutNode): boolean =>
    a.boundaryParent === b.boundaryParent ||
    (!inDrawnBoundary(a) && !inDrawnBoundary(b));

  const swappable: LayoutNode[] = [...options.nodes].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  let changed = false;
  const maxGenerations = Math.min(3, Math.max(0, options.generations));
  for (let generation = 0; generation < maxGenerations; generation++) {
    const baselineMeasure = options.measure();
    if (!baselineMeasure) return changed;
    const baselinePositions = snapshot(options.nodes);
    let bestEdgeLength = baselineMeasure.edgeLength;
    let bestPositions: ReturnType<typeof snapshot> | null = null;

    for (let first = 0; first < swappable.length; first++) {
      for (let second = first + 1; second < swappable.length; second++) {
        const a = swappable[first];
        const b = swappable[second];
        if (!canSwap(a, b)) continue;
        restore(options.nodes, baselinePositions);
        [a.x, b.x] = [b.x, a.x];
        [a.y, b.y] = [b.y, a.y];
        const candidateMeasure = options.measure();
        if (!candidateMeasure) continue;
        const candidateScore = compactness(candidateMeasure);
        const improvementScale = Math.max(
          1,
          Math.abs(bestEdgeLength),
          Math.abs(candidateMeasure.edgeLength),
        );
        if (
          candidateScore.area <= maximumArea + EPSILON &&
          candidateMeasure.edgeLength < bestEdgeLength - improvementScale * 1e-9
        ) {
          bestEdgeLength = candidateMeasure.edgeLength;
          bestPositions = snapshot(options.nodes);
        }
      }
    }

    restore(options.nodes, bestPositions ?? baselinePositions);
    if (!bestPositions) break;
    changed = true;
    emitIteration(options, "node-swap", generation + 1);
  }
  return changed;
}
