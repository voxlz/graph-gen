import type { LayoutNode } from "../layout";
import { minimizeTowardCenter } from "./center";
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

interface EscapeCandidate {
  node: LayoutNode;
  axis: "x" | "y";
  value: number;
  key: string;
}

function sweptRect(
  node: LayoutNode,
  axis: "x" | "y",
  center: number,
  padding: number,
): MinimizeRect {
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
  blocker: MinimizeRect,
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

function escapeCandidates(options: MinimizeOptions): EscapeCandidate[] {
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
        candidates.set(key, { ...escape, node: moving, key });
      }
    }
  }

  return [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function minimizeBlockerEscapes(
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

    for (const candidate of escapeCandidates(options)) {
      restore(options.nodes, baselinePositions);
      candidate.node[candidate.axis] = candidate.value;
      minimizeTowardCenter(
        { ...options, onIteration: undefined },
        Math.min(10, options.generations),
      );
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
    emitIteration(options, "blocker-escape", generation + 1);
  }
  return changed;
}
