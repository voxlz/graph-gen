import type { LayoutNode } from "../layout";
import {
  compactness,
  compareByKeys,
  emitIteration,
  EPSILON,
  measureBounds,
  nodeRect,
  restore,
  setNodeAxis,
  snapshot,
} from "./shared";
import type { MinimizeOptions, MinimizeRect } from "./types";

function layoutCenter(nodes: LayoutNode[]): { x: number; y: number } {
  const bounds = measureBounds(nodes.map((node) => nodeRect(node)));
  return bounds
    ? {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      }
    : { x: 0, y: 0 };
}

function tryMinimizeAxis(
  options: MinimizeOptions,
  node: LayoutNode,
  axis: "x" | "y",
  center: number,
): boolean {
  const original = node[axis];
  const delta = center - original;
  if (Math.abs(delta) <= EPSILON) return false;
  const originalPositions = snapshot(options.nodes);
  for (const fraction of [
    1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125, 0.00390625,
    0.001953125,
  ]) {
    restore(options.nodes, originalPositions);
    setNodeAxis(options, node, axis, original + delta * fraction);
    if (options.isValid(false) && options.isValid(true)) return true;
  }
  restore(options.nodes, originalPositions);
  return false;
}

function tryMinimizeContainerAxis(
  options: MinimizeOptions,
  id: string,
  axis: "x" | "y",
  target: number,
): boolean {
  const rect = options.containerRect?.(id);
  if (!rect || !options.setContainerAxis) return false;
  const original =
    axis === "x" ? (rect.minX + rect.maxX) / 2 : (rect.minY + rect.maxY) / 2;
  const delta = target - original;
  if (Math.abs(delta) <= EPSILON) return false;
  const baselineMeasure = options.measure();
  if (!baselineMeasure) return false;
  const baselineScore = compactness(baselineMeasure);
  const originalPositions = snapshot(options.nodes);
  for (const fraction of [1, 0.5, 0.25, 0.125, 0.0625, 0.03125]) {
    restore(options.nodes, originalPositions);
    options.setContainerAxis(id, axis, original + delta * fraction);
    const candidateMeasure = options.measure();
    if (
      candidateMeasure &&
      compareByKeys(compactness(candidateMeasure), baselineScore, [
        "area",
        "perimeter",
        "largestDimension",
        "edgeLength",
      ]) < 0
    ) {
      return true;
    }
  }
  restore(options.nodes, originalPositions);
  return false;
}

export function minimizeTowardCenter(
  options: MinimizeOptions,
  generations = options.generations,
): boolean {
  let changed = false;
  for (let generation = 0; generation < generations; generation++) {
    let moved = false;
    for (const axis of ["x", "y"] as const) {
      const center = layoutCenter(options.nodes)[axis];
      const containerIds = options.containerIds ?? [];
      if (generation < 3 && containerIds.length > 1) {
        const containers = [...containerIds].sort((a, b) => {
          const coordinate = (rect: MinimizeRect | null | undefined) =>
            rect
              ? axis === "x"
                ? (rect.minX + rect.maxX) / 2
                : (rect.minY + rect.maxY) / 2
              : center;
          return (
            Math.abs(coordinate(options.containerRect?.(b)) - center) -
              Math.abs(coordinate(options.containerRect?.(a)) - center) ||
            a.localeCompare(b)
          );
        });
        for (const id of containers) {
          moved = tryMinimizeContainerAxis(options, id, axis, center) || moved;
          for (const peerId of containers) {
            if (peerId === id) continue;
            const peerRect = options.containerRect?.(peerId);
            if (!peerRect) continue;
            const peerCenter =
              axis === "x"
                ? (peerRect.minX + peerRect.maxX) / 2
                : (peerRect.minY + peerRect.maxY) / 2;
            if (tryMinimizeContainerAxis(options, id, axis, peerCenter)) {
              moved = true;
              break;
            }
          }
        }
      }
      const orderedNodes = [...options.nodes].sort(
        (a, b) =>
          Math.abs(b[axis] - center) - Math.abs(a[axis] - center) ||
          a.id.localeCompare(b.id),
      );
      for (const node of orderedNodes) {
        moved = tryMinimizeAxis(options, node, axis, center) || moved;
      }
    }
    if (!moved) break;
    changed = true;
    emitIteration(options, "center", generation + 1);
  }
  return changed;
}
