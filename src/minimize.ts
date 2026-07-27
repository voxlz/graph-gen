import { minimizeBlockerEscapes } from "./strategies/blocker-escape";
import { minimizeTowardCenter } from "./strategies/center";
import { minimizeDisconnectedPerimeter } from "./strategies/disconnected-perimeter";
import { minimizeEdgeLengths } from "./strategies/edge-shortening";
import { minimizeNodeSwaps } from "./strategies/node-swap";
import { minimizeSharedNeighborSpread } from "./strategies/shared-neighbor-spread";
import {
  compactness,
  compareByKeys,
  restore,
  snapshot,
} from "./strategies/shared";
import type { MinimizeOptions, StrategyFrame } from "./strategies/types";

export type {
  MinimizeMeasure,
  MinimizeObstacle,
  MinimizeOptions,
} from "./strategies/types";

export function minimizeLayout(options: MinimizeOptions): void {
  for (let cycle = 0; cycle < options.generations; cycle++) {
    const baselineMeasure = options.measure();
    if (!baselineMeasure) return;
    const baselineScore = compactness(baselineMeasure);
    const baselinePositions = snapshot(options.nodes);
    const cycleFrames: StrategyFrame[] = [];
    const cycleOptions: MinimizeOptions = {
      ...options,
      onIteration: (frame) => cycleFrames.push(frame),
    };

    minimizeTowardCenter(cycleOptions);
    const stagesMeasure = cycleOptions.measure();
    if (!stagesMeasure) {
      restore(options.nodes, baselinePositions);
      return;
    }
    const maximumArea = compactness(stagesMeasure).area * 1.05;
    minimizeEdgeLengths(cycleOptions, maximumArea);
    minimizeBlockerEscapes(cycleOptions, maximumArea);
    minimizeNodeSwaps(cycleOptions, maximumArea);
    minimizeSharedNeighborSpread(cycleOptions, maximumArea);
    minimizeDisconnectedPerimeter(cycleOptions, maximumArea);

    const candidateMeasure = options.measure();
    const candidateScore = candidateMeasure
      ? compactness(candidateMeasure)
      : null;
    if (
      candidateScore &&
      compareByKeys(candidateScore, baselineScore, [
        "area",
        "perimeter",
        "largestDimension",
        "edgeLength",
      ]) < 0
    ) {
      for (const frame of cycleFrames) options.onIteration?.(frame);
      continue;
    }
    restore(options.nodes, baselinePositions);
    break;
  }
  const finalMeasure = options.measure();
  if (finalMeasure) {
    minimizeSharedNeighborSpread(
      options,
      compactness(finalMeasure).area * 1.05,
    );
  }
  options.measure();
}
