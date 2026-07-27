import type { LayoutNode } from "../layout";
import { emitIteration, EPSILON, measureBounds, nodeRect } from "./shared";
import type { MinimizeOptions } from "./types";

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
  for (const fraction of [
    1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125, 0.00390625,
    0.001953125,
  ]) {
    node[axis] = original + delta * fraction;
    if (options.isValid(false) && options.isValid(true)) return true;
    node[axis] = original;
  }
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
