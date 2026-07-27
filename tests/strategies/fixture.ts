import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LayoutNode } from "../../src/layout";
import {
  expandRect,
  nodeRect,
  rectanglesOverlap,
} from "../../src/strategies/shared";
import type {
  MinimizeDirection,
  MinimizeMeasure,
  MinimizeOptions,
  MinimizeRect,
  StrategyFrame,
} from "../../src/strategies/types";

export interface StrategyFixture {
  name: string;
  nodeGap: number;
  directionalGap?: number;
  generations: number;
  viewport: MinimizeRect;
  nodes: LayoutNode[];
  edges: Array<[string, string]>;
  directions?: MinimizeDirection[];
  boundaries: Array<MinimizeRect & { id: string }>;
}

export interface StrategyCase {
  fixture: StrategyFixture;
  options: MinimizeOptions;
  frames: StrategyFrame[];
}

function loadFixture(name: string): StrategyFixture {
  const path = join(__dirname, "cases", `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8")) as StrategyFixture;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function segmentIntersectsRect(segment: Segment, rect: MinimizeRect): boolean {
  let low = 0;
  let high = 1;
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const clips: Array<[number, number]> = [
    [-dx, segment.x1 - rect.minX],
    [dx, rect.maxX - segment.x1],
    [-dy, segment.y1 - rect.minY],
    [dy, rect.maxY - segment.y1],
  ];
  for (const [direction, distance] of clips) {
    if (Math.abs(direction) < 0.01) {
      if (distance < 0) return false;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) low = Math.max(low, ratio);
    else high = Math.min(high, ratio);
    if (low > high) return false;
  }
  return true;
}

function segmentsCross(first: Segment, second: Segment): boolean {
  const orient = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const firstStart = orient(
    first.x1,
    first.y1,
    first.x2,
    first.y2,
    second.x1,
    second.y1,
  );
  const firstEnd = orient(
    first.x1,
    first.y1,
    first.x2,
    first.y2,
    second.x2,
    second.y2,
  );
  const secondStart = orient(
    second.x1,
    second.y1,
    second.x2,
    second.y2,
    first.x1,
    first.y1,
  );
  const secondEnd = orient(
    second.x1,
    second.y1,
    second.x2,
    second.y2,
    first.x2,
    first.y2,
  );
  return (
    ((firstStart > 0.01 && firstEnd < -0.01) ||
      (firstStart < -0.01 && firstEnd > 0.01)) &&
    ((secondStart > 0.01 && secondEnd < -0.01) ||
      (secondStart < -0.01 && secondEnd > 0.01))
  );
}

function valid(fixture: StrategyFixture, nodes: LayoutNode[]): boolean {
  for (let first = 0; first < nodes.length; first++) {
    for (let second = first + 1; second < nodes.length; second++) {
      if (
        rectanglesOverlap(
          expandRect(nodeRect(nodes[first]), fixture.nodeGap / 2),
          expandRect(nodeRect(nodes[second]), fixture.nodeGap / 2),
        )
      ) {
        return false;
      }
    }
  }

  for (const node of nodes) {
    const rect = nodeRect(node);
    for (const boundary of fixture.boundaries) {
      if (node.boundaryParent === boundary.id) {
        if (
          rect.minX < boundary.minX ||
          rect.maxX > boundary.maxX ||
          rect.minY < boundary.minY ||
          rect.maxY > boundary.maxY
        ) {
          return false;
        }
      } else if (
        rectanglesOverlap(expandRect(rect, fixture.nodeGap / 2), boundary)
      ) {
        return false;
      }
    }
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const directionalGap = fixture.directionalGap ?? fixture.nodeGap;
  for (const direction of fixture.directions ?? []) {
    const a = nodeById.get(direction.a);
    const b = nodeById.get(direction.b);
    if (!a || !b) return false;
    const aRect = nodeRect(a);
    const bRect = nodeRect(b);
    if (
      (["left", "topleft", "bottomleft"].includes(direction.type) &&
        aRect.maxX + directionalGap > bRect.minX + 0.01) ||
      (["right", "topright", "bottomright"].includes(direction.type) &&
        bRect.maxX + directionalGap > aRect.minX + 0.01) ||
      (["top", "topleft", "topright"].includes(direction.type) &&
        aRect.maxY + directionalGap > bRect.minY + 0.01) ||
      (["bottom", "bottomleft", "bottomright"].includes(direction.type) &&
        bRect.maxY + directionalGap > aRect.minY + 0.01)
    ) {
      return false;
    }
  }
  const edges = fixture.edges.map(([sourceId, targetId]) => ({
    source: nodeById.get(sourceId)!,
    target: nodeById.get(targetId)!,
  }));
  const segments = edges.map(({ source, target }) => ({
    x1: source.x,
    y1: source.y,
    x2: target.x,
    y2: target.y,
  }));
  for (const [edgeIndex, edge] of edges.entries()) {
    for (const node of nodes) {
      if (node === edge.source || node === edge.target) continue;
      if (
        segmentIntersectsRect(
          segments[edgeIndex],
          expandRect(nodeRect(node), 2),
        )
      ) {
        return false;
      }
    }
  }
  for (let first = 0; first < edges.length; first++) {
    for (let second = first + 1; second < edges.length; second++) {
      const sharesEndpoint =
        edges[first].source === edges[second].source ||
        edges[first].source === edges[second].target ||
        edges[first].target === edges[second].source ||
        edges[first].target === edges[second].target;
      if (!sharesEndpoint && segmentsCross(segments[first], segments[second])) {
        return false;
      }
    }
  }
  return true;
}

export function createStrategyCase(name: string): StrategyCase {
  const fixture = loadFixture(name);
  const nodes = fixture.nodes.map((node) => ({ ...node }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = fixture.edges.map(([source, target]) => ({
    source: nodeById.get(source)!,
    target: nodeById.get(target)!,
  }));
  const frames: StrategyFrame[] = [];
  const measure = (): MinimizeMeasure | null => {
    if (!valid(fixture, nodes)) return null;
    return {
      rects: [
        ...nodes.map((node) => nodeRect(node)),
        ...fixture.boundaries.map((boundary) => ({
          minX: boundary.minX,
          minY: boundary.minY,
          maxX: boundary.maxX,
          maxY: boundary.maxY,
        })),
      ],
      edgeLength: edges.reduce(
        (sum, edge) =>
          sum +
          Math.hypot(
            edge.target.x - edge.source.x,
            edge.target.y - edge.source.y,
          ),
        0,
      ),
    };
  };
  return {
    fixture,
    frames,
    options: {
      nodes,
      edges,
      nodeGap: fixture.nodeGap,
      directionalGap: fixture.directionalGap ?? fixture.nodeGap,
      directions: fixture.directions,
      generations: fixture.generations,
      obstacles: () => [
        ...nodes.map((node) => ({
          id: node.id,
          kind: "node" as const,
          rect: nodeRect(node),
          node,
        })),
        ...fixture.boundaries.map(({ id, ...rect }) => ({
          id,
          kind: "boundary" as const,
          rect,
        })),
      ],
      isValid: () => valid(fixture, nodes),
      measure,
      onIteration: (frame) => frames.push(frame),
    },
  };
}
