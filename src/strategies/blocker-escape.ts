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
  setNodeAxis,
  snapshot,
} from "./shared";
import type { MinimizeOptions, MinimizeRect } from "./types";

interface MovableEntity {
  id: string;
  rect: MinimizeRect;
  parent: string | null;
  setAxis: (axis: "x" | "y", value: number) => void;
  isBoundary: boolean;
}

interface EscapeCandidate {
  moving: MovableEntity;
  axis: "x" | "y";
  value: number;
  key: string;
}

function movableEntities(options: MinimizeOptions): MovableEntity[] {
  if (
    !options.elementAlignmentContainerIds ||
    !options.childEntityIds ||
    !options.entityRect ||
    !options.setEntityAxis
  ) {
    return options.nodes.map((node) => ({
      id: node.id,
      rect: nodeRect(node),
      parent: node.boundaryParent,
      setAxis: (axis, value) => setNodeAxis(options, node, axis, value),
      isBoundary: false,
    }));
  }

  const nodeById = new Map(options.nodes.map((node) => [node.id, node]));
  const entities = new Map<string, MovableEntity>();
  for (const parent of options.elementAlignmentContainerIds) {
    for (const id of options.childEntityIds(parent)) {
      if (entities.has(id)) continue;
      const rect = options.entityRect(id);
      if (!rect) continue;
      const node = nodeById.get(id);
      entities.set(id, {
        id,
        rect,
        parent,
        setAxis: node
          ? (axis, value) => setNodeAxis(options, node, axis, value)
          : (axis, value) => options.setEntityAxis!(id, axis, value),
        isBoundary: node === undefined,
      });
    }
  }
  return [...entities.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function sweptRect(
  rect: MinimizeRect,
  axis: "x" | "y",
  start: number,
  center: number,
  padding: number,
): MinimizeRect {
  const end = { ...rect };
  const delta = center - start;
  if (axis === "x") {
    end.minX += delta;
    end.maxX += delta;
  } else {
    end.minY += delta;
    end.maxY += delta;
  }
  return expandRect(
    {
      minX: Math.min(rect.minX, end.minX),
      maxX: Math.max(rect.maxX, end.maxX),
      minY: Math.min(rect.minY, end.minY),
      maxY: Math.max(rect.maxY, end.maxY),
    },
    padding,
  );
}

function perpendicularEscapes(
  moving: MovableEntity,
  blocker: MinimizeRect,
  inwardAxis: "x" | "y",
  clearance: number,
): Array<{ axis: "x" | "y"; value: number }> {
  const width = moving.rect.maxX - moving.rect.minX;
  const height = moving.rect.maxY - moving.rect.minY;
  if (inwardAxis === "x") {
    return [
      {
        axis: "y",
        value: blocker.minY - height / 2 - clearance,
      },
      {
        axis: "y",
        value: blocker.maxY + height / 2 + clearance,
      },
    ];
  }
  return [
    {
      axis: "x",
      value: blocker.minX - width / 2 - clearance,
    },
    {
      axis: "x",
      value: blocker.maxX + width / 2 + clearance,
    },
  ];
}

function escapeCandidates(options: MinimizeOptions): EscapeCandidate[] {
  const measured = options.measure();
  const bounds = measured && measureBounds(measured.rects);
  if (!bounds) return [];
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
  const candidates = new Map<string, EscapeCandidate>();
  const entities = movableEntities(options);

  for (const subject of entities) {
    const siblings = entities.filter(
      (candidate) => candidate.parent === subject.parent,
    );
    const siblingBounds = measureBounds(siblings.map(({ rect }) => rect));
    if (!siblingBounds) continue;
    for (const inwardAxis of ["x", "y"] as const) {
      const subjectCenter =
        inwardAxis === "x"
          ? (subject.rect.minX + subject.rect.maxX) / 2
          : (subject.rect.minY + subject.rect.maxY) / 2;
      if (Math.abs(subjectCenter - center[inwardAxis]) <= EPSILON) {
        continue;
      }
      const isExtremal =
        inwardAxis === "x"
          ? subjectCenter < center.x
            ? subject.rect.minX <= siblingBounds.minX + EPSILON
            : subject.rect.maxX >= siblingBounds.maxX - EPSILON
          : subjectCenter < center.y
            ? subject.rect.minY <= siblingBounds.minY + EPSILON
            : subject.rect.maxY >= siblingBounds.maxY - EPSILON;
      if (!isExtremal) continue;
      const sweep = sweptRect(
        subject.rect,
        inwardAxis,
        subjectCenter,
        center[inwardAxis],
        options.nodeGap / 2,
      );
      const direction = Math.sign(center[inwardAxis] - subjectCenter);
      const blockers = siblings
        .filter((candidate) => {
          if (candidate.id === subject.id) return false;
          const candidateCenter =
            inwardAxis === "x"
              ? (candidate.rect.minX + candidate.rect.maxX) / 2
              : (candidate.rect.minY + candidate.rect.maxY) / 2;
          return (
            (candidateCenter - subjectCenter) * direction > 0 &&
            rectanglesOverlap(
              sweep,
              expandRect(candidate.rect, options.nodeGap / 2),
            )
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
            Math.abs(aCenter - subjectCenter) -
              Math.abs(bCenter - subjectCenter) || a.id.localeCompare(b.id)
          );
        });
      const nearest = blockers[0];
      if (!nearest) continue;
      const clearance = options.nodeGap;
      for (const escape of perpendicularEscapes(
        nearest,
        subject.rect,
        inwardAxis,
        clearance,
      )) {
        const key = `${subject.id}:${nearest.id}:${escape.axis}:${escape.value.toFixed(3)}`;
        candidates.set(key, { ...escape, moving: nearest, key });
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
      candidate.moving.setAxis(candidate.axis, candidate.value);
      minimizeTowardCenter(
        {
          ...options,
          containerIds: movableEntities(options)
            .filter((entity) => entity.isBoundary)
            .map((entity) => entity.id),
          onIteration: undefined,
        },
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
