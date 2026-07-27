import type { LayoutNode } from "../layout";
import {
  compactness,
  compareByKeys,
  emitIteration,
  EPSILON,
  restore,
  setNodeAxis,
  snapshot,
} from "./shared";
import type { MinimizeOptions } from "./types";

interface EdgeCandidate {
  node: LayoutNode;
  axis: "x" | "y";
  value: number;
  key: string;
}

function edgeCandidates(options: MinimizeOptions): EdgeCandidate[] {
  const candidates = new Map<string, EdgeCandidate>();
  for (const [edgeIndex, edge] of options.edges.entries()) {
    for (const [moving, target] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ] as const) {
      for (const axis of ["x", "y"] as const) {
        const delta = target[axis] - moving[axis];
        if (Math.abs(delta) <= EPSILON) continue;
        for (const fraction of [0.5, 0.25, 0.125]) {
          const value = moving[axis] + delta * fraction;
          const key = `edge:${edgeIndex}:${moving.id}:${axis}:${fraction}`;
          candidates.set(key, { node: moving, axis, value, key });
        }
      }
    }
  }
  return [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function minimizeEdgeLengths(
  options: MinimizeOptions,
  maximumArea: number,
): boolean {
  let changed = false;
  const maxGenerations = Math.min(3, Math.max(0, options.generations));
  for (let generation = 0; generation < maxGenerations; generation++) {
    const baselineMeasure = options.measure();
    if (!baselineMeasure) return changed;
    const baselineScore = compactness(baselineMeasure);
    const baselinePositions = snapshot(options.nodes);
    let bestScore = baselineScore;
    let bestPositions: ReturnType<typeof snapshot> | null = null;

    for (const candidate of edgeCandidates(options)) {
      restore(options.nodes, baselinePositions);
      setNodeAxis(options, candidate.node, candidate.axis, candidate.value);
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

    restore(options.nodes, bestPositions ?? baselinePositions);
    if (!bestPositions) break;
    changed = true;
    emitIteration(options, "edge-shortening", generation + 1);
  }
  return changed;
}
