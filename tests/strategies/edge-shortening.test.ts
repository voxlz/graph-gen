import { minimizeEdgeLengths } from "../../src/strategies/edge-shortening";
import { compactness } from "../../src/strategies/shared";
import { createStrategyCase } from "./fixture";

test("edge-shortening strategy shortens edges within the area budget", () => {
  const strategyCase = createStrategyCase("edge-shortening");
  expect(strategyCase.options.isValid(true)).toBe(true);
  const before = compactness(strategyCase.options.measure()!);

  expect(minimizeEdgeLengths(strategyCase.options, before.area * 1.05)).toBe(
    true,
  );

  const after = compactness(strategyCase.options.measure()!);
  expect(after.edgeLength).toBeLessThan(before.edgeLength);
  expect(after.area).toBeLessThanOrEqual(before.area * 1.05);
  expect(strategyCase.options.isValid(true)).toBe(true);
  expect(
    strategyCase.frames.every((frame) => frame.strategy === "edge-shortening"),
  ).toBe(true);
});
