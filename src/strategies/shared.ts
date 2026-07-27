import type { LayoutNode } from "../layout";
import type { MinimizeMeasure, MinimizeOptions, MinimizeRect } from "./types";

export interface CompactnessScore {
  area: number;
  perimeter: number;
  largestDimension: number;
  edgeLength: number;
}

export interface NodePosition {
  x: number;
  y: number;
}

export const EPSILON = 0.01;

export function nodeRect(node: LayoutNode): MinimizeRect {
  return {
    minX: node.x - node.width / 2,
    maxX: node.x + node.width / 2,
    minY: node.y - node.height / 2,
    maxY: node.y + node.height / 2,
  };
}

export function expandRect(rect: MinimizeRect, padding: number): MinimizeRect {
  return {
    minX: rect.minX - padding,
    maxX: rect.maxX + padding,
    minY: rect.minY - padding,
    maxY: rect.maxY + padding,
  };
}

export function rectanglesOverlap(a: MinimizeRect, b: MinimizeRect): boolean {
  return (
    a.minX < b.maxX - EPSILON &&
    a.maxX > b.minX + EPSILON &&
    a.minY < b.maxY - EPSILON &&
    a.maxY > b.minY + EPSILON
  );
}

export function measureBounds(rects: MinimizeRect[]): MinimizeRect | null {
  if (rects.length === 0) return null;
  return rects.reduce<MinimizeRect>(
    (bounds, rect) => ({
      minX: Math.min(bounds.minX, rect.minX),
      maxX: Math.max(bounds.maxX, rect.maxX),
      minY: Math.min(bounds.minY, rect.minY),
      maxY: Math.max(bounds.maxY, rect.maxY),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

export function compactness(measure: MinimizeMeasure): CompactnessScore {
  const bounds = measureBounds(measure.rects);
  if (!bounds) {
    return {
      area: 0,
      perimeter: 0,
      largestDimension: 0,
      edgeLength: measure.edgeLength,
    };
  }
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  return {
    area: width * height,
    perimeter: 2 * (width + height),
    largestDimension: Math.max(width, height),
    edgeLength: measure.edgeLength,
  };
}

export function compareByKeys(
  a: CompactnessScore,
  b: CompactnessScore,
  keys: ReadonlyArray<keyof CompactnessScore>,
): number {
  for (const key of keys) {
    const scale = Math.max(1, Math.abs(a[key]), Math.abs(b[key]));
    if (Math.abs(a[key] - b[key]) > scale * 1e-9) {
      return a[key] - b[key];
    }
  }
  return 0;
}

export function snapshot(nodes: LayoutNode[]): NodePosition[] {
  return nodes.map(({ x, y }) => ({ x, y }));
}

export function restore(nodes: LayoutNode[], positions: NodePosition[]): void {
  nodes.forEach((node, index) => {
    node.x = positions[index].x;
    node.y = positions[index].y;
  });
}

export function setNodeAxis(
  options: MinimizeOptions,
  node: LayoutNode,
  axis: "x" | "y",
  value: number,
): void {
  if (options.setNodeAxis) options.setNodeAxis(node, axis, value);
  else node[axis] = value;
}

export function emitIteration(
  options: MinimizeOptions,
  strategy: string,
  iteration: number,
): void {
  options.onIteration?.({
    strategy,
    iteration,
    nodes: options.nodes.map(({ id, x, y, width, height }) => ({
      id,
      x,
      y,
      width,
      height,
    })),
  });
}
