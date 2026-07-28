import type { LayoutNode } from "../layout";
import {
  compactness,
  emitIteration,
  EPSILON,
  nodeRect,
  restore,
  setNodeAxis,
  snapshot,
} from "./shared";
import type { MinimizeOptions } from "./types";

const SWAP_AXES = [["x", "y"], ["x"], ["y"]] as const;

function swappedCenters(
  first: ReturnType<typeof nodeRect>,
  second: ReturnType<typeof nodeRect>,
  axis: "x" | "y",
): { first: number; second: number } {
  const minimum = axis === "x" ? "minX" : "minY";
  const maximum = axis === "x" ? "maxX" : "maxY";
  const firstSize = first[maximum] - first[minimum];
  const secondSize = second[maximum] - second[minimum];
  if (first[maximum] <= second[minimum] + EPSILON) {
    return {
      first: second[maximum] - firstSize / 2,
      second: first[minimum] + secondSize / 2,
    };
  }
  if (second[maximum] <= first[minimum] + EPSILON) {
    return {
      first: second[minimum] + firstSize / 2,
      second: first[maximum] - secondSize / 2,
    };
  }
  return {
    first: (second[minimum] + second[maximum]) / 2,
    second: (first[minimum] + first[maximum]) / 2,
  };
}

export function minimizeNodeSwaps(
  options: MinimizeOptions,
  maximumArea: number,
  mode: "all" | "boundary-only" | "nodes-only" = "all",
): boolean {
  const swappable: LayoutNode[] = [...options.nodes].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const swappableContainers = [...(options.swappableContainerIds ?? [])].sort(
    (a, b) => a.localeCompare(b),
  );

  let changed = false;
  const maxGenerations = Math.min(3, Math.max(0, options.generations));
  for (let generation = 0; generation < maxGenerations; generation++) {
    const baselineMeasure = options.measure();
    if (!baselineMeasure) return changed;
    const baselinePositions = snapshot(options.nodes);
    const baselineElementArea = options.elementAreaScore?.();
    let bestEdgeLength = baselineMeasure.edgeLength;
    let bestElementArea = baselineElementArea;
    let bestImprovesElementArea = false;
    let bestPositions: ReturnType<typeof snapshot> | null = null;
    const considerCandidate = () => {
      const candidateMeasure = options.measure();
      if (!candidateMeasure) return;
      const candidateScore = compactness(candidateMeasure);
      const candidateElementArea = options.elementAreaScore?.();
      const improvementScale = Math.max(
        1,
        Math.abs(baselineMeasure.edgeLength),
        Math.abs(candidateMeasure.edgeLength),
      );
      const improvesEdges =
        candidateMeasure.edgeLength <
        baselineMeasure.edgeLength - improvementScale * 1e-9;
      const elementAreaScale = Math.max(
        1,
        Math.abs(baselineElementArea ?? 0),
        Math.abs(candidateElementArea ?? 0),
      );
      const improvesElementArea =
        baselineElementArea !== undefined &&
        candidateElementArea !== undefined &&
        candidateElementArea < baselineElementArea - elementAreaScale * 1e-9;
      const betterElementArea =
        candidateElementArea !== undefined &&
        (bestElementArea === undefined ||
          candidateElementArea < bestElementArea - elementAreaScale * 1e-9);
      const sameElementArea =
        candidateElementArea !== undefined &&
        bestElementArea !== undefined &&
        Math.abs(candidateElementArea - bestElementArea) <=
          elementAreaScale * 1e-9;
      const betterCandidate = improvesElementArea
        ? !bestImprovesElementArea ||
          betterElementArea ||
          (sameElementArea && candidateMeasure.edgeLength < bestEdgeLength)
        : !bestImprovesElementArea &&
          candidateMeasure.edgeLength < bestEdgeLength;
      if (
        candidateScore.area <= maximumArea + EPSILON &&
        improvesEdges &&
        betterCandidate
      ) {
        bestEdgeLength = candidateMeasure.edgeLength;
        bestElementArea = candidateElementArea;
        bestImprovesElementArea = improvesElementArea;
        bestPositions = snapshot(options.nodes);
      }
    };

    if (mode !== "boundary-only") {
      for (let first = 0; first < swappable.length; first++) {
        for (let second = first + 1; second < swappable.length; second++) {
          const a = swappable[first];
          const b = swappable[second];
          for (const axes of SWAP_AXES) {
            restore(options.nodes, baselinePositions);
            const firstRect = nodeRect(a);
            const secondRect = nodeRect(b);
            for (const axis of axes) {
              const target = swappedCenters(firstRect, secondRect, axis);
              a[axis] = target.first;
              b[axis] = target.second;
            }
            considerCandidate();
          }
        }
      }
    }

    if (
      mode !== "nodes-only" &&
      options.containerParent &&
      options.containerRect &&
      options.setContainerAxis
    ) {
      for (const node of swappable) {
        for (const id of swappableContainers) {
          if (node.boundaryParent !== options.containerParent(id)) continue;
          for (const axes of SWAP_AXES) {
            restore(options.nodes, baselinePositions);
            const rect = options.containerRect(id);
            if (!rect) continue;
            const nodeBounds = nodeRect(node);
            for (const axis of axes) {
              const target = swappedCenters(nodeBounds, rect, axis);
              options.setContainerAxis(id, axis, target.second);
              setNodeAxis(options, node, axis, target.first);
            }
            considerCandidate();
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
