import { minimizeBlockerEscapes } from "./strategies/blocker-escape";
import { minimizeTowardCenter } from "./strategies/center";
import { minimizeDisconnectedPerimeter } from "./strategies/disconnected-perimeter";
import { minimizeEdgeLengths } from "./strategies/edge-shortening";
import { minimizeNodeSwaps } from "./strategies/node-swap";
import { minimizeSharedHubCompaction } from "./strategies/shared-hub-compaction";
import {
  angularReadabilityWeight,
  angularRelaxationScore,
  minimizeAngularRelaxation,
  readabilityCost,
} from "./strategies/angular-relaxation";
import {
  compactness,
  compareByKeys,
  EPSILON,
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
    const angularWeight = angularReadabilityWeight(options.edges);
    const baselineReadability = readabilityCost(
      baselineScore.edgeLength,
      baselineAngularScore,
      options.nodeGap,
      angularWeight,
    );
    const candidateReadability = candidateScore
      ? readabilityCost(
          candidateScore.edgeLength,
          candidateAngularScore,
          options.nodeGap,
          angularWeight,
        )
      : null;
    const readabilityImproved =
      candidateReadability !== null &&
      candidateReadability < baselineReadability - EPSILON;
    const readabilityNotWorse =
      candidateReadability !== null &&
      candidateReadability <= baselineReadability + EPSILON;
    const compactnessChanged =
      candidateScore !== null &&
      (["area", "perimeter", "largestDimension", "edgeLength"] as const).some(
        (key) => Math.abs(candidateScore[key] - baselineScore[key]) > EPSILON,
      );
    if (
      compactnessComparison !== null &&
      (readabilityImproved ||
        (readabilityNotWorse &&
          compactnessChanged &&
          compactnessComparison < 0))
    ) {
      for (const frame of cycleFrames) options.onIteration?.(frame);
      continue;
    }
    restore(options.nodes, baselinePositions);
    break;
  }
  options.measure();
}
