import { minimizeBlockerEscapes } from "./strategies/blocker-escape";
import { minimizeTowardCenter } from "./strategies/center";
import { minimizeDisconnectedPerimeter } from "./strategies/disconnected-perimeter";
import { minimizeEdgeLengths } from "./strategies/edge-shortening";
import { minimizeNodeSwaps } from "./strategies/node-swap";
import { minimizeSharedHubCompaction } from "./strategies/shared-hub-compaction";
import { minimizeElementAlignment } from "./strategies/element-alignment";
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
    const baselineElementArea = options.elementAreaScore?.();
    const baselinePositions = snapshot(options.nodes);
    const cycleFrames: StrategyFrame[] = [];
    const cycleOptions: MinimizeOptions = {
      ...options,
      onIteration: (frame) => cycleFrames.push(frame),
    };
    const runAreaPreserving = (
      stage: (stageOptions: MinimizeOptions) => void,
    ) => {
      const stagePositions = snapshot(options.nodes);
      const stageElementArea = options.elementAreaScore?.();
      const frameCount = cycleFrames.length;
      stage(cycleOptions);
      const candidateElementArea = options.elementAreaScore?.();
      if (
        stageElementArea !== undefined &&
        candidateElementArea !== undefined &&
        candidateElementArea > stageElementArea + EPSILON
      ) {
        restore(options.nodes, stagePositions);
        cycleFrames.length = frameCount;
      }
    };

    const initialMaximumArea = baselineScore.area * 1.05;
    const preservesElementArea = options.elementAreaScore !== undefined;
    if (preservesElementArea) {
      runAreaPreserving((stageOptions) =>
        minimizeNodeSwaps(stageOptions, initialMaximumArea, "boundary-only"),
      );
      runAreaPreserving(minimizeTowardCenter);
    } else {
      minimizeTowardCenter(cycleOptions);
    }
    const stagesMeasure = cycleOptions.measure();
    if (!stagesMeasure) {
      restore(options.nodes, baselinePositions);
      return;
    }
    const maximumArea = compactness(stagesMeasure).area * 1.05;
    if (preservesElementArea) {
      runAreaPreserving((stageOptions) =>
        minimizeAngularRelaxation(stageOptions, maximumArea),
      );
      runAreaPreserving((stageOptions) =>
        minimizeSharedHubCompaction(stageOptions, maximumArea),
      );
      runAreaPreserving((stageOptions) =>
        minimizeEdgeLengths(stageOptions, maximumArea),
      );
      runAreaPreserving((stageOptions) =>
        minimizeBlockerEscapes(stageOptions, maximumArea),
      );
      runAreaPreserving((stageOptions) =>
        minimizeNodeSwaps(stageOptions, maximumArea, "nodes-only"),
      );
      runAreaPreserving(minimizeElementAlignment);
      runAreaPreserving((stageOptions) =>
        minimizeDisconnectedPerimeter(stageOptions, maximumArea),
      );
    } else {
      minimizeAngularRelaxation(cycleOptions, maximumArea);
      minimizeSharedHubCompaction(cycleOptions, maximumArea);
      minimizeEdgeLengths(cycleOptions, maximumArea);
      minimizeBlockerEscapes(cycleOptions, maximumArea);
      minimizeNodeSwaps(cycleOptions, maximumArea);
      minimizeDisconnectedPerimeter(cycleOptions, maximumArea);
    }

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
    const candidateElementArea = options.elementAreaScore?.();
    const elementAreaImproved =
      baselineElementArea !== undefined &&
      candidateElementArea !== undefined &&
      candidateElementArea < baselineElementArea - EPSILON;
    if (
      compactnessComparison !== null &&
      (readabilityImproved ||
        (readabilityNotWorse &&
          ((compactnessChanged && compactnessComparison < 0) ||
            elementAreaImproved)))
    ) {
      for (const frame of cycleFrames) options.onIteration?.(frame);
      continue;
    }
    restore(options.nodes, baselinePositions);
    break;
  }
  options.measure();
}
