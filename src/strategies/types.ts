import type { LayoutNode } from "../layout";

export interface MinimizeRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface MinimizeObstacle {
  id: string;
  kind: "node" | "boundary";
  rect: MinimizeRect;
  node?: LayoutNode;
}

export interface MinimizeMeasure {
  rects: MinimizeRect[];
  edgeLength: number;
}

export interface MinimizeEdge {
  source: LayoutNode;
  target: LayoutNode;
}

export interface MinimizeDirection {
  type: string;
  a: string;
  b: string;
}

export interface StrategyFrame {
  strategy: string;
  iteration: number;
  nodes: Array<Pick<LayoutNode, "id" | "x" | "y" | "width" | "height">>;
}

export interface MinimizeOptions {
  nodes: LayoutNode[];
  edges: MinimizeEdge[];
  nodeGap: number;
  directionalGap?: number;
  directions?: MinimizeDirection[];
  generations: number;
  setNodeAxis?: (node: LayoutNode, axis: "x" | "y", value: number) => void;
  containerIds?: string[];
  drawnContainerIds?: string[];
  containerRect?: (id: string) => MinimizeRect | null;
  setContainerAxis?: (id: string, axis: "x" | "y", value: number) => void;
  obstacles: () => MinimizeObstacle[];
  isValid: (includeLabels: boolean) => boolean;
  measure: () => MinimizeMeasure | null;
  onIteration?: (frame: StrategyFrame) => void;
}
