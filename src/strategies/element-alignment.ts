import {
  compactness,
  compareByKeys,
  emitIteration,
  EPSILON,
  expandRect,
  measureBounds,
  nodeRect,
  rectanglesOverlap,
  restore,
  snapshot,
} from "./shared";
import type { MinimizeOptions, MinimizeRect } from "./types";

const ALIGNMENT_ANCHORS = ["start", "center", "end"] as const;
type AlignmentAnchor = (typeof ALIGNMENT_ANCHORS)[number];

function rectArea(rect: MinimizeRect): number {
  return (rect.maxX - rect.minX) * (rect.maxY - rect.minY);
}

function axisCenter(rect: MinimizeRect, axis: "x" | "y"): number {
  return axis === "x"
    ? (rect.minX + rect.maxX) / 2
    : (rect.minY + rect.maxY) / 2;
}

function axisAnchor(
  rect: MinimizeRect,
  axis: "x" | "y",
  anchor: AlignmentAnchor,
): number {
  if (anchor === "center") return axisCenter(rect, axis);
  if (axis === "x") return anchor === "start" ? rect.minX : rect.maxX;
  return anchor === "start" ? rect.minY : rect.maxY;
}

function alignedCenter(
  moving: MinimizeRect,
  target: MinimizeRect,
  axis: "x" | "y",
  anchor: AlignmentAnchor,
): number {
  return (
    axisCenter(moving, axis) +
    axisAnchor(target, axis, anchor) -
    axisAnchor(moving, axis, anchor)
  );
}

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

export function minimizeElementAlignment(options: MinimizeOptions): boolean {
  if (
    !options.elementAlignmentContainerIds ||
    !options.childEntityIds ||
    !options.entityRect ||
    !options.setEntityAxis ||
    !options.regionRect
  ) {
    return false;
  }

  let changed = false;
  const maxGenerations = Math.min(3, Math.max(0, options.generations));
  for (let generation = 0; generation < maxGenerations; generation++) {
    let moved = false;
    for (const parent of options.elementAlignmentContainerIds) {
      const entities = [...options.childEntityIds(parent)].sort((a, b) =>
        a.localeCompare(b),
      );
      if (entities.length < 2) continue;
      const baselineMeasure = options.measure();
      const baselineRegion = options.regionRect(parent);
      if (!baselineMeasure || !baselineRegion) continue;
      const baselinePositions = snapshot(options.nodes);
      const baselineElementArea = options.elementAreaScore?.();
      let bestArea = rectArea(baselineRegion);
      let bestScore = compactness(baselineMeasure);
      let bestPositions: ReturnType<typeof snapshot> | null = null;
      const considerCandidate = (): "invalid" | "worse" | "valid" => {
        if (hasNodeClearanceViolation(options)) return "invalid";
        const candidateMeasure = options.measure();
        const candidateRegion = options.regionRect?.(parent);
        if (!candidateMeasure || !candidateRegion) return "invalid";
        const candidateElementArea = options.elementAreaScore?.();
        if (
          baselineElementArea !== undefined &&
          candidateElementArea !== undefined &&
          candidateElementArea > baselineElementArea + EPSILON
        ) {
          return "worse";
        }
        const candidateArea = rectArea(candidateRegion);
        const areaScale = Math.max(1, Math.abs(bestArea), candidateArea);
        const candidateScore = compactness(candidateMeasure);
        if (
          candidateArea < bestArea - areaScale * 1e-9 ||
          (Math.abs(candidateArea - bestArea) <= areaScale * 1e-9 &&
            compareByKeys(candidateScore, bestScore, [
              "area",
              "perimeter",
              "largestDimension",
              "edgeLength",
            ]) < 0)
        ) {
          bestArea = candidateArea;
          bestScore = candidateScore;
          bestPositions = snapshot(options.nodes);
        }
        return "valid";
      };

      for (const axis of ["x", "y"] as const) {
        const entityRects = entities
          .map((id) => ({ id, rect: options.entityRect?.(id) ?? null }))
          .filter(
            (entry): entry is { id: string; rect: MinimizeRect } =>
              entry.rect !== null,
          );
        const bounds = measureBounds(entityRects.map(({ rect }) => rect));
        if (!bounds) continue;
        const minimum = axis === "x" ? "minX" : "minY";
        const maximum = axis === "x" ? "maxX" : "maxY";

        for (const moving of entityRects) {
          if (
            !options.isBoundaryEntity?.(moving.id) &&
            moving.rect[minimum] > bounds[minimum] + EPSILON &&
            moving.rect[maximum] < bounds[maximum] - EPSILON
          ) {
            continue;
          }
          const targetCenters = [
            ...new Set(
              entityRects
                .filter((target) => target.id !== moving.id)
                .flatMap((target) =>
                  ALIGNMENT_ANCHORS.map((anchor) =>
                    alignedCenter(moving.rect, target.rect, axis, anchor),
                  ),
                ),
            ),
          ].sort((a, b) => a - b);
          for (const targetCenter of targetCenters) {
            const originalCenter = axisCenter(moving.rect, axis);
            if (Math.abs(targetCenter - originalCenter) <= EPSILON) continue;
            restore(options.nodes, baselinePositions);
            options.setEntityAxis(moving.id, axis, targetCenter);
            considerCandidate();
          }
        }

        for (const anchor of ALIGNMENT_ANCHORS) {
          const groupTargets = [
            ...new Set(
              entityRects.map(({ rect }) => axisAnchor(rect, axis, anchor)),
            ),
          ].sort((a, b) => a - b);
          for (const target of groupTargets) {
            restore(options.nodes, baselinePositions);
            let adjusted = false;
            for (const entity of entityRects) {
              const current = axisAnchor(entity.rect, axis, anchor);
              if (Math.abs(current - target) <= EPSILON) continue;
              options.setEntityAxis(
                entity.id,
                axis,
                axisCenter(entity.rect, axis) + target - current,
              );
              adjusted = true;
            }
            if (adjusted) considerCandidate();
          }
        }
      }

      restore(options.nodes, bestPositions ?? baselinePositions);
      moved = bestPositions !== null || moved;
    }
    if (!moved) break;
    changed = true;
    emitIteration(options, "element-alignment", generation + 1);
  }
  return changed;
}
