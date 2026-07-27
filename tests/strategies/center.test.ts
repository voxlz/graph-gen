import { compactness } from "../../src/strategies/shared";
import { minimizeTowardCenter } from "../../src/strategies/center";
import { createStrategyCase } from "./fixture";

test("center strategy reduces rendered area and emits accepted iterations", () => {
  const strategyCase = createStrategyCase("center");
  const before = compactness(strategyCase.options.measure()!);

  expect(minimizeTowardCenter(strategyCase.options)).toBe(true);

  const after = compactness(strategyCase.options.measure()!);
  expect(after.area).toBeLessThan(before.area);
  expect(strategyCase.frames.length).toBeGreaterThan(0);
  expect(
    strategyCase.frames.every((frame) => frame.strategy === "center"),
  ).toBe(true);
});

test("center strategy bounds its internal generations", () => {
  const strategyCase = createStrategyCase("center");
  strategyCase.options.generations = 100;

  minimizeTowardCenter(strategyCase.options);

  expect(strategyCase.frames.length).toBeLessThanOrEqual(10);
});
