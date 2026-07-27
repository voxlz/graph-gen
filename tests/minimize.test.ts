import { minimizeLayout } from "../src/minimize";
import { compactness } from "../src/strategies/shared";
import { createStrategyCase } from "./strategies/fixture";

test("minimizeLayout keeps valid improvements from its strategy cycle", () => {
  const strategyCase = createStrategyCase("edge-shortening");
  const before = compactness(strategyCase.options.measure()!);

  minimizeLayout(strategyCase.options);

  const finalMeasure = strategyCase.options.measure();
  expect(finalMeasure).not.toBeNull();
  const after = compactness(finalMeasure!);
  expect(after.area).toBeLessThan(before.area);
  expect(after.edgeLength).toBeLessThan(before.edgeLength);
  expect(strategyCase.frames.length).toBeGreaterThan(0);
});
