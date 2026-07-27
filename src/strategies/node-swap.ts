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
  const containers = new Map<string | null, LayoutNode[]>();
  for (const node of options.nodes) {
    const siblings = containers.get(node.boundaryParent) ?? [];
    siblings.push(node);
    containers.set(node.boundaryParent, siblings);
  }
  const siblingGroups = [...containers.values()]
    .map((siblings) => siblings.sort((a, b) => a.id.localeCompare(b.id)))
    .filter((siblings) => siblings.length > 1)
    .sort((a, b) => a[0].id.localeCompare(b[0].id));

  let changed = false;
  const maxGenerations = Math.min(3, Math.max(0, options.generations));
  for (let generation = 0; generation < maxGenerations; generation++) {
    const baselineMeasure = options.measure();
    if (!baselineMeasure) return changed;
    const baselinePositions = snapshot(options.nodes);
    let bestEdgeLength = baselineMeasure.edgeLength;
    let bestPositions: ReturnType<typeof snapshot> | null = null;

    for (const siblings of siblingGroups) {
      for (let first = 0; first < siblings.length; first++) {
        for (let second = first + 1; second < siblings.length; second++) {
          restore(options.nodes, baselinePositions);
          const a = siblings[first];
          const b = siblings[second];
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
            candidateMeasure.edgeLength <
              bestEdgeLength - improvementScale * 1e-9
          ) {
            bestEdgeLength = candidateMeasure.edgeLength;
            bestPositions = snapshot(options.nodes);
          }
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
