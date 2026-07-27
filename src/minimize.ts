import { minimizeBlockerEscapes } from "./strategies/blocker-escape";
import { minimizeTowardCenter } from "./strategies/center";
import { minimizeDisconnectedPerimeter } from "./strategies/disconnected-perimeter";
import { minimizeEdgeLengths } from "./strategies/edge-shortening";
import { minimizeNodeSwaps } from "./strategies/node-swap";
import { minimizeSharedHubCompaction } from "./strategies/shared-hub-compaction";
import {
  ANGULAR_IMPROVEMENT_EPSILON,
  angularRelaxationScore,
  minimizeAngularRelaxation,
} from "./strategies/angular-relaxation";
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
    const baselineAngularScore = angularRelaxationScore(options.edges);
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
    minimizeAngularRelaxation(cycleOptions, maximumArea);
    minimizeSharedHubCompaction(cycleOptions, maximumArea);
    minimizeEdgeLengths(cycleOptions, maximumArea);
    minimizeBlockerEscapes(cycleOptions, maximumArea);
    minimizeNodeSwaps(cycleOptions, maximumArea);
    minimizeDisconnectedPerimeter(cycleOptions, maximumArea);

    const candidateMeasure = options.measure();
    const candidateScore = candidateMeasure
      ? compactness(candidateMeasure)
      : null;
    const compactnessComparison = candidateScore
      ? compareByKeys(candidateScore, baselineScore, [
          "area",
          "perimeter",
          "largestDimension",
          "edgeLength",
        ])
      : null;
    const candidateAngularScore = angularRelaxationScore(options.edges);
    const angularImproved =
      candidateAngularScore <
      baselineAngularScore - ANGULAR_IMPROVEMENT_EPSILON;
    const angularNotWorse =
      candidateAngularScore <=
      baselineAngularScore + ANGULAR_IMPROVEMENT_EPSILON;
    if (
      compactnessComparison !== null &&
      ((compactnessComparison < 0 && angularNotWorse) ||
        (compactnessComparison === 0 && angularImproved))
    ) {
      for (const frame of cycleFrames) options.onIteration?.(frame);
      continue;
    }
    restore(options.nodes, baselinePositions);
    break;
  }
  options.measure();
}
