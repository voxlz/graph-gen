import type { LayoutNode } from "../layout";
import {
  compactness,
  compareByKeys,
  emitIteration,
  EPSILON,
  expandRect,
  nodeRect,
  rectanglesOverlap,
  restore,
  setNodeAxis,
  snapshot,
} from "./shared";
import type { MinimizeOptions, MinimizeRect } from "./types";

// A blocker sitting in the corridor is either shoved further out along its own
// radius, or slid sideways around the hub to the nearest free slot. Which one
// pays off depends on the topology, so both are offered as rival candidates.
type BlockerDisplacement = "radial" | "tangential";

const TANGENTIAL_STEP = Math.PI / 90;
// A blocker steps aside to make room; it does not relocate to the far side of
// the hub. Past a third of a turn the pull stops being compaction and starts
// rearranging the hub, so candidates needing more than that are abandoned.
const MAX_TANGENTIAL_TURN = Math.PI / 3;

interface HubPullCandidate {
  hub: LayoutNode;
  neighbor: LayoutNode;
  axis: "x" | "y";
  value: number;
  displacement: BlockerDisplacement;
  key: string;
}

function hubPullCandidates(options: MinimizeOptions): HubPullCandidate[] {
  const neighborsByHub = new Map<LayoutNode, Set<LayoutNode>>();
  for (const edge of options.edges) {
    if (edge.source === edge.target) continue;
    for (const [hub, neighbor] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ] as const) {
      const neighbors = neighborsByHub.get(hub) ?? new Set<LayoutNode>();
      neighbors.add(neighbor);
      neighborsByHub.set(hub, neighbors);
    }
  }

  const candidates: HubPullCandidate[] = [];
  for (const [hub, neighbors] of neighborsByHub) {
    if (neighbors.size < 2) continue;
    for (const neighbor of neighbors) {
      for (const axis of ["x", "y"] as const) {
        const delta = hub[axis] - neighbor[axis];
        if (Math.abs(delta) <= EPSILON) continue;
        for (const fraction of [0.5, 0.25, 0.125]) {
          for (const displacement of ["radial", "tangential"] as const) {
            candidates.push({
              hub,
              neighbor,
              axis,
              value: neighbor[axis] + delta * fraction,
              displacement,
              key: `${hub.id}:${neighbor.id}:${axis}:${fraction}:${displacement}`,
            });
          }
        }
      }
    }
  }
  return candidates.sort((a, b) => a.key.localeCompare(b.key));
}

function radialClearanceScale(
  hub: LayoutNode,
  blocker: LayoutNode,
  candidate: LayoutNode,
  axis: "x" | "y",
  nodeGap: number,
): number | null {
  const perpendicularAxis = axis === "x" ? "y" : "x";
  const axes = [axis, perpendicularAxis] as const;
  const scales: number[] = [];
  for (const currentAxis of axes) {
    const radialOffset = blocker[currentAxis] - hub[currentAxis];
    if (Math.abs(radialOffset) <= EPSILON) continue;
    const clearance =
      (currentAxis === "x"
        ? blocker.width + candidate.width
        : blocker.height + candidate.height) /
        2 +
      nodeGap;
    const separation = blocker[currentAxis] - candidate[currentAxis];
    const direction = Math.sign(separation || radialOffset);
    if (direction * radialOffset <= EPSILON) continue;
    const scale =
      (candidate[currentAxis] + direction * clearance - hub[currentAxis]) /
      radialOffset;
    if (scale >= 1 - EPSILON) scales.push(Math.max(1, scale));
  }
  return scales.length ? Math.min(...scales) : null;
}

// Slide the blocker around the hub at a fixed radius until it clears the
// corridor and every other node, taking the smallest rotation that works.
// Holding the radius keeps the blocker's own edge length unchanged, so the
// pulled neighbour's saving is the whole of the trade.
function tangentialClearance(
  options: MinimizeOptions,
  hub: LayoutNode,
  blocker: LayoutNode,
  neighbor: LayoutNode,
  corridor: MinimizeRect,
): { x: number; y: number } | null {
  const radius = Math.hypot(blocker.x - hub.x, blocker.y - hub.y);
  if (radius <= EPSILON) return null;
  const currentAngle = Math.atan2(blocker.y - hub.y, blocker.x - hub.x);
  const steps = Math.floor(MAX_TANGENTIAL_TURN / TANGENTIAL_STEP);

  for (let step = 1; step <= steps; step++) {
    for (const direction of [1, -1] as const) {
      const angle = currentAngle + direction * step * TANGENTIAL_STEP;
      const x = hub.x + Math.cos(angle) * radius;
      const y = hub.y + Math.sin(angle) * radius;
      const rect = expandRect(
        nodeRect({ ...blocker, x, y }),
        options.nodeGap / 2,
      );
      if (rectanglesOverlap(corridor, rect)) continue;
      const collides = options.nodes.some(
        (node) =>
          node !== blocker &&
          node !== neighbor &&
          rectanglesOverlap(
            rect,
            expandRect(nodeRect(node), options.nodeGap / 2),
          ),
      );
      if (!collides) return { x, y };
    }
  }
  return null;
}

function pullNeighborPastBlockers(
  options: MinimizeOptions,
  candidate: HubPullCandidate,
): number {
  const { hub, neighbor, axis, value, displacement } = candidate;
  const candidateNode = { ...neighbor, [axis]: value };
  const candidateRect = expandRect(
    nodeRect(candidateNode),
    options.nodeGap / 2,
  );
  const hubNeighbors = new Set(
    options.edges.flatMap((edge) => {
      if (edge.source === hub) return [edge.target];
      if (edge.target === hub) return [edge.source];
      return [];
    }),
  );
  const blockers = options.nodes
    .filter(
      (node) =>
        node !== neighbor &&
        node !== hub &&
        hubNeighbors.has(node) &&
        rectanglesOverlap(
          candidateRect,
          expandRect(nodeRect(node), options.nodeGap / 2),
        ),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  let displaced = 0;
  for (const blocker of blockers) {
    if (displacement === "tangential") {
      const slot = tangentialClearance(
        options,
        hub,
        blocker,
        neighbor,
        candidateRect,
      );
      if (slot === null) continue;
      setNodeAxis(options, blocker, "x", slot.x);
      setNodeAxis(options, blocker, "y", slot.y);
      displaced++;
      continue;
    }
    const scale = radialClearanceScale(
      hub,
      blocker,
      candidateNode,
      axis,
      options.nodeGap,
    );
    if (scale === null) continue;
    setNodeAxis(options, blocker, "x", hub.x + (blocker.x - hub.x) * scale);
    setNodeAxis(options, blocker, "y", hub.y + (blocker.y - hub.y) * scale);
    displaced++;
  }
  setNodeAxis(options, neighbor, axis, value);
  return displaced;
}

export function minimizeSharedHubCompaction(
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

    for (const candidate of hubPullCandidates(options)) {
      restore(options.nodes, baselinePositions);
      // Opening a corridor past radial blockers is this strategy's job. A pull
      // with nothing in the way is a plain inward move, which belongs to
      // edge shortening, so it is not offered here.
      if (pullNeighborPastBlockers(options, candidate) === 0) continue;
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
    emitIteration(options, "shared-hub-compaction", generation + 1);
  }
  return changed;
}
