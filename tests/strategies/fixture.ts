import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LayoutNode } from "../../src/layout";
import {
  expandRect,
  measureBounds,
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
  boundaries: Array<
    MinimizeRect & {
      id: string;
      parent?: string | null;
      dynamic?: boolean;
      padding?: number;
      swappable?: boolean;
      elementAlignmentFixed?: boolean;
    }
  >;
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

function belongsToBoundary(
  fixture: StrategyFixture,
  node: LayoutNode,
  boundaryId: string,
): boolean {
  const boundaryById = new Map(
    fixture.boundaries.map((boundary) => [boundary.id, boundary]),
  );
  let current = node.boundaryParent;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === boundaryId) return true;
    seen.add(current);
    current = boundaryById.get(current)?.parent ?? null;
  }
  return false;
}

export function fixtureBoundaryRects(
  fixture: StrategyFixture,
  nodes: LayoutNode[],
): Array<MinimizeRect & { id: string }> {
  return fixture.boundaries.flatMap((boundary) => {
    if (!boundary.dynamic) return [{ ...boundary }];
    const members = nodes.filter((node) =>
      belongsToBoundary(fixture, node, boundary.id),
    );
    if (members.length === 0) return [];
    const padding = boundary.padding ?? fixture.nodeGap;
    return [
      {
        id: boundary.id,
        minX: Math.min(...members.map((node) => nodeRect(node).minX)) - padding,
        minY: Math.min(...members.map((node) => nodeRect(node).minY)) - padding,
        maxX: Math.max(...members.map((node) => nodeRect(node).maxX)) + padding,
        maxY: Math.max(...members.map((node) => nodeRect(node).maxY)) + padding,
      },
    ];
  });
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

  const boundaries = fixtureBoundaryRects(fixture, nodes);
  for (const node of nodes) {
    const rect = nodeRect(node);
    for (const definition of fixture.boundaries) {
      const boundary = boundaries.find(({ id }) => id === definition.id);
      if (!boundary) continue;
      if (belongsToBoundary(fixture, node, boundary.id)) {
        if (
          rect.minX < boundary.minX ||
          rect.maxX > boundary.maxX ||
          rect.minY < boundary.minY ||
          rect.maxY > boundary.maxY
        ) {
          return false;
        }
        continue;
      }
      if (rectanglesOverlap(expandRect(rect, fixture.nodeGap / 2), boundary)) {
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
  const directEntityIds = (parent: string | null) => [
    ...nodes
      .filter((node) => node.boundaryParent === parent)
      .map((node) => node.id),
    ...fixture.boundaries
      .filter((boundary) => (boundary.parent ?? null) === parent)
      .map((boundary) => boundary.id),
  ];
  const entityRect = (id: string) => {
    const node = nodeById.get(id);
    return (
      (node ? nodeRect(node) : null) ??
      fixtureBoundaryRects(fixture, nodes).find(
        (boundary) => boundary.id === id,
      ) ??
      null
    );
  };
  const regionRect = (parent: string | null) =>
    parent === null
      ? measureBounds(
          directEntityIds(null).flatMap((id) => {
            const rect = entityRect(id);
            return rect ? [rect] : [];
          }),
        )
      : entityRect(parent);
  const elementAlignmentContainerIds: Array<string | null> = [
    ...fixture.boundaries.map((boundary) => boundary.id).reverse(),
    null,
  ];
  const alignmentEntityIds = (parent: string | null) =>
    directEntityIds(parent).filter(
      (id) =>
        !fixture.boundaries.find((boundary) => boundary.id === id)
          ?.elementAlignmentFixed,
    );
  const measure = (): MinimizeMeasure | null => {
    if (!valid(fixture, nodes)) return null;
    const boundaries = fixtureBoundaryRects(fixture, nodes);
    return {
      rects: [
        ...nodes.map((node) => nodeRect(node)),
        ...boundaries.map((boundary) => ({
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
      swappableContainerIds: fixture.boundaries
        .filter((boundary) => boundary.swappable)
        .map((boundary) => boundary.id),
      containerParent: (id) =>
        fixture.boundaries.find((boundary) => boundary.id === id)?.parent ??
        null,
      containerRect: (id) =>
        fixtureBoundaryRects(fixture, nodes).find(
          (boundary) => boundary.id === id,
        ) ?? null,
      setContainerAxis: (id, axis, value) => {
        const rect = fixtureBoundaryRects(fixture, nodes).find(
          (boundary) => boundary.id === id,
        );
        if (!rect) return;
        const center =
          axis === "x"
            ? (rect.minX + rect.maxX) / 2
            : (rect.minY + rect.maxY) / 2;
        const delta = value - center;
        for (const node of nodes) {
          if (belongsToBoundary(fixture, node, id)) node[axis] += delta;
        }
      },
      elementAlignmentContainerIds,
      childEntityIds: alignmentEntityIds,
      isBoundaryEntity: (id) =>
        fixture.boundaries.some((boundary) => boundary.id === id),
      entityRect,
      setEntityAxis: (id, axis, value) => {
        const rect = entityRect(id);
        if (!rect) return;
        const center =
          axis === "x"
            ? (rect.minX + rect.maxX) / 2
            : (rect.minY + rect.maxY) / 2;
        const delta = value - center;
        const node = nodeById.get(id);
        if (node) node[axis] += delta;
        else {
          if (
            fixture.boundaries.find((boundary) => boundary.id === id)
              ?.elementAlignmentFixed
          ) {
            return;
          }
          for (const member of nodes) {
            if (belongsToBoundary(fixture, member, id)) member[axis] += delta;
          }
        }
      },
      regionRect,
      elementAreaScore: () =>
        fixture.boundaries.reduce((total, boundary) => {
          const parent = boundary.id;
          const rect = regionRect(parent);
          return rect
            ? total + (rect.maxX - rect.minX) * (rect.maxY - rect.minY)
            : total;
        }, 0),
      obstacles: () => [
        ...nodes.map((node) => ({
          id: node.id,
          kind: "node" as const,
          rect: nodeRect(node),
          node,
        })),
        ...fixtureBoundaryRects(fixture, nodes).map(({ id, ...rect }) => ({
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
