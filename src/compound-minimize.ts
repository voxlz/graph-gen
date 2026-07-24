import type { LayoutNode } from "./constraint-layout";

interface CompactRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CompactObstacle {
  id: string;
  kind: "node" | "boundary";
  rect: CompactRect;
  node?: LayoutNode;
}

export interface CompactLayoutMeasure {
  rects: CompactRect[];
  edgeLength: number;
}

interface CompactEdge {
  source: LayoutNode;
  target: LayoutNode;
}

export interface CompoundMinimizeOptions {
  nodes: LayoutNode[];
  edges: CompactEdge[];
  nodeGap: number;
  generations: number;
  obstacles: () => CompactObstacle[];
  measure: () => CompactLayoutMeasure | null;
  relax: () => void;
}

interface CompactnessScore {
  area: number;
  perimeter: number;
  largestDimension: number;
  edgeLength: number;
}

interface NodePosition {
  x: number;
  y: number;
}

interface EscapeCandidate {
  node: LayoutNode;
  axis: "x" | "y";
  value: number;
  key: string;
  relax?: boolean;
}

interface PositionCandidate {
  node: LayoutNode;
  x: number;
  y: number;
  key: string;
}

const EPSILON = 0.01;

function nodeRect(node: LayoutNode): CompactRect {
  return {
    minX: node.x - node.width / 2,
    maxX: node.x + node.width / 2,
    minY: node.y - node.height / 2,
    maxY: node.y + node.height / 2,
  };
}

function expandRect(rect: CompactRect, padding: number): CompactRect {
  return {
    minX: rect.minX - padding,
    maxX: rect.maxX + padding,
    minY: rect.minY - padding,
    maxY: rect.maxY + padding,
  };
}

function rectanglesOverlap(a: CompactRect, b: CompactRect): boolean {
  return (
    a.minX < b.maxX - EPSILON &&
    a.maxX > b.minX + EPSILON &&
    a.minY < b.maxY - EPSILON &&
    a.maxY > b.minY + EPSILON
  );
}

function measureBounds(rects: CompactRect[]): CompactRect | null {
  if (rects.length === 0) return null;
  return rects.reduce<CompactRect>(
    (bounds, rect) => ({
      minX: Math.min(bounds.minX, rect.minX),
      maxX: Math.max(bounds.maxX, rect.maxX),
      minY: Math.min(bounds.minY, rect.minY),
      maxY: Math.max(bounds.maxY, rect.maxY),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

function compactness(measure: CompactLayoutMeasure): CompactnessScore {
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

function compareScores(a: CompactnessScore, b: CompactnessScore): number {
  for (const key of [
    "edgeLength",
    "area",
    "perimeter",
    "largestDimension",
  ] as const) {
    const scale = Math.max(1, Math.abs(a[key]), Math.abs(b[key]));
    if (Math.abs(a[key] - b[key]) > scale * 1e-9) {
      return a[key] - b[key];
    }
  }
  return 0;
}

function edgeCandidates(options: CompoundMinimizeOptions): EscapeCandidate[] {
  const candidates = new Map<string, EscapeCandidate>();
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
  return [...candidates.values()];
}

function snapshot(nodes: LayoutNode[]): NodePosition[] {
  return nodes.map(({ x, y }) => ({ x, y }));
}

function restore(nodes: LayoutNode[], positions: NodePosition[]): void {
  nodes.forEach((node, index) => {
    node.x = positions[index].x;
    node.y = positions[index].y;
  });
}

function minimizeNodeSwaps(
  options: CompoundMinimizeOptions,
  maximumArea: number,
): void {
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

  const maxGenerations = Math.min(3, Math.max(0, options.generations));
  for (let generation = 0; generation < maxGenerations; generation++) {
    const baselineMeasure = options.measure();
    if (!baselineMeasure) return;
    const baselinePositions = snapshot(options.nodes);
    let bestEdgeLength = baselineMeasure.edgeLength;
    let bestPositions: NodePosition[] | null = null;

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
  }
}

function perimeterCandidates(
  options: CompoundMinimizeOptions,
  node: LayoutNode,
): PositionCandidate[] {
  const candidates = new Map<string, PositionCandidate>();
  const peers = options.nodes.filter(
    (other) => other !== node && other.boundaryParent === node.boundaryParent,
  );
  for (const obstacle of options.obstacles()) {
    if (obstacle.node === node) continue;
    const clearance =
      obstacle.kind === "boundary" ? options.nodeGap / 2 : options.nodeGap;
    const horizontalSlots = [
      (obstacle.rect.minX + obstacle.rect.maxX) / 2,
      ...peers.flatMap((peer) => [
        peer.x,
        peer.x - peer.width / 2 - node.width / 2 - options.nodeGap,
        peer.x + peer.width / 2 + node.width / 2 + options.nodeGap,
      ]),
    ];
    const verticalSlots = [
      (obstacle.rect.minY + obstacle.rect.maxY) / 2,
      ...peers.flatMap((peer) => [
        peer.y,
        peer.y - peer.height / 2 - node.height / 2 - options.nodeGap,
        peer.y + peer.height / 2 + node.height / 2 + options.nodeGap,
      ]),
    ];
    const top = obstacle.rect.minY - node.height / 2 - clearance;
    const bottom = obstacle.rect.maxY + node.height / 2 + clearance;
    const left = obstacle.rect.minX - node.width / 2 - clearance;
    const right = obstacle.rect.maxX + node.width / 2 + clearance;
    for (const x of horizontalSlots) {
      for (const y of [top, bottom]) {
        const key = `${node.id}:${x.toFixed(3)}:${y.toFixed(3)}`;
        candidates.set(key, { node, x, y, key });
      }
    }
    for (const y of verticalSlots) {
      for (const x of [left, right]) {
        const key = `${node.id}:${x.toFixed(3)}:${y.toFixed(3)}`;
        candidates.set(key, { node, x, y, key });
      }
    }
  }
  return [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function minimizeDisconnectedPerimeter(
  options: CompoundMinimizeOptions,
  maximumArea: number,
): void {
  const connected = new Set<LayoutNode>();
  for (const edge of options.edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  const disconnected = options.nodes
    .filter((node) => !connected.has(node))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (disconnected.length === 0) return;

  const baselineMeasure = options.measure();
  if (!baselineMeasure) return;
  const baselinePositions = snapshot(options.nodes);
  let bestScore = compactness(baselineMeasure);
  let bestPositions: NodePosition[] | null = null;

  for (const node of disconnected) {
    for (const candidate of perimeterCandidates(options, node)) {
      restore(options.nodes, baselinePositions);
      candidate.node.x = candidate.x;
      candidate.node.y = candidate.y;
      const candidateMeasure = options.measure();
      if (!candidateMeasure) continue;
      const candidateScore = compactness(candidateMeasure);
      if (
        candidateScore.area <= maximumArea + EPSILON &&
        (candidateScore.area < bestScore.area - EPSILON ||
          (Math.abs(candidateScore.area - bestScore.area) <= EPSILON &&
            (candidateScore.perimeter < bestScore.perimeter - EPSILON ||
              (Math.abs(candidateScore.perimeter - bestScore.perimeter) <=
                EPSILON &&
                candidateScore.largestDimension <
                  bestScore.largestDimension - EPSILON))))
      ) {
        bestScore = candidateScore;
        bestPositions = snapshot(options.nodes);
      }
    }
  }

  restore(options.nodes, bestPositions ?? baselinePositions);
}

function sweptRect(
  node: LayoutNode,
  axis: "x" | "y",
  center: number,
  padding: number,
): CompactRect {
  const start = nodeRect(node);
  const end = { ...start };
  const delta = center - node[axis];
  if (axis === "x") {
    end.minX += delta;
    end.maxX += delta;
  } else {
    end.minY += delta;
    end.maxY += delta;
  }
  return expandRect(
    {
      minX: Math.min(start.minX, end.minX),
      maxX: Math.max(start.maxX, end.maxX),
      minY: Math.min(start.minY, end.minY),
      maxY: Math.max(start.maxY, end.maxY),
    },
    padding,
  );
}

function perpendicularEscapes(
  moving: LayoutNode,
  blocker: CompactRect,
  inwardAxis: "x" | "y",
  clearance: number,
): Array<{ axis: "x" | "y"; value: number }> {
  if (inwardAxis === "x") {
    return [
      {
        axis: "y",
        value: blocker.minY - moving.height / 2 - clearance,
      },
      {
        axis: "y",
        value: blocker.maxY + moving.height / 2 + clearance,
      },
    ];
  }
  return [
    {
      axis: "x",
      value: blocker.minX - moving.width / 2 - clearance,
    },
    {
      axis: "x",
      value: blocker.maxX + moving.width / 2 + clearance,
    },
  ];
}

function escapeCandidates(options: CompoundMinimizeOptions): EscapeCandidate[] {
  const measured = options.measure();
  const bounds = measured && measureBounds(measured.rects);
  if (!bounds) return [];
  const nodeBounds = measureBounds(options.nodes.map((node) => nodeRect(node)));
  if (!nodeBounds) return [];
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
  const candidates = new Map<string, EscapeCandidate>();
  const obstacles = options.obstacles();

  for (const subject of [...options.nodes].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    for (const inwardAxis of ["x", "y"] as const) {
      if (Math.abs(subject[inwardAxis] - center[inwardAxis]) <= EPSILON) {
        continue;
      }
      const subjectRect = nodeRect(subject);
      const isExtremal =
        inwardAxis === "x"
          ? subject.x < center.x
            ? subjectRect.minX <= nodeBounds.minX + EPSILON
            : subjectRect.maxX >= nodeBounds.maxX - EPSILON
          : subject.y < center.y
            ? subjectRect.minY <= nodeBounds.minY + EPSILON
            : subjectRect.maxY >= nodeBounds.maxY - EPSILON;
      if (!isExtremal) continue;
      const sweep = sweptRect(
        subject,
        inwardAxis,
        center[inwardAxis],
        options.nodeGap / 2,
      );
      const direction = Math.sign(center[inwardAxis] - subject[inwardAxis]);
      const blockers = obstacles
        .filter((obstacle) => {
          if (obstacle.node === subject) return false;
          const obstacleCenter =
            inwardAxis === "x"
              ? (obstacle.rect.minX + obstacle.rect.maxX) / 2
              : (obstacle.rect.minY + obstacle.rect.maxY) / 2;
          const obstaclePadding =
            obstacle.kind === "node" ? options.nodeGap / 2 : 0;
          return (
            (obstacleCenter - subject[inwardAxis]) * direction > 0 &&
            rectanglesOverlap(sweep, expandRect(obstacle.rect, obstaclePadding))
          );
        })
        .sort((a, b) => {
          const aCenter =
            inwardAxis === "x"
              ? (a.rect.minX + a.rect.maxX) / 2
              : (a.rect.minY + a.rect.maxY) / 2;
          const bCenter =
            inwardAxis === "x"
              ? (b.rect.minX + b.rect.maxX) / 2
              : (b.rect.minY + b.rect.maxY) / 2;
          return (
            Math.abs(aCenter - subject[inwardAxis]) -
              Math.abs(bCenter - subject[inwardAxis]) ||
            a.id.localeCompare(b.id)
          );
        });
      const nearest = blockers[0];
      if (!nearest) continue;
      const moving = nearest.node ?? subject;
      const blocker = nearest.node ? nodeRect(subject) : nearest.rect;
      const clearance =
        nearest.kind === "node" ? options.nodeGap : options.nodeGap / 2;
      for (const escape of perpendicularEscapes(
        moving,
        blocker,
        inwardAxis,
        clearance,
      )) {
        const key = `${moving.id}:${escape.axis}:${escape.value.toFixed(3)}`;
        candidates.set(key, { ...escape, node: moving, key, relax: true });
      }
    }
  }

  return [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function minimizeCompoundLayout(options: CompoundMinimizeOptions): void {
  const maxGenerations = Math.min(3, Math.max(0, options.generations));
  const initialMeasure = options.measure();
  if (!initialMeasure) return;
  const maximumArea = compactness(initialMeasure).area * 1.05;
  for (let generation = 0; generation < maxGenerations; generation++) {
    const baselineMeasure = options.measure();
    if (!baselineMeasure) return;
    const baselineScore = compactness(baselineMeasure);
    const baselinePositions = snapshot(options.nodes);
    let bestScore = baselineScore;
    let bestPositions: NodePosition[] | null = null;

    const candidates = [
      ...edgeCandidates(options),
      ...escapeCandidates(options),
    ].sort((a, b) => a.key.localeCompare(b.key));
    for (const candidate of candidates) {
      restore(options.nodes, baselinePositions);
      candidate.node[candidate.axis] = candidate.value;
      if (candidate.relax) options.relax();
      const candidateMeasure = options.measure();
      if (!candidateMeasure) continue;
      const candidateScore = compactness(candidateMeasure);
      if (
        candidateScore.area <= maximumArea + EPSILON &&
        compareScores(candidateScore, bestScore) < 0
      ) {
        bestScore = candidateScore;
        bestPositions = snapshot(options.nodes);
      }
    }

    restore(options.nodes, bestPositions ?? baselinePositions);
    if (!bestPositions) break;
  }
  minimizeNodeSwaps(options, maximumArea);
  minimizeDisconnectedPerimeter(options, maximumArea);
  options.measure();
}
