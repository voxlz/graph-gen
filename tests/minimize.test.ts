import { minimizeLayout } from "../src/minimize";
import { angularRelaxationScore } from "../src/strategies/angular-relaxation";
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

test("minimizeLayout does no work when the generation limit is zero", () => {
  const strategyCase = createStrategyCase("angular-relaxation");
  const before = strategyCase.options.nodes.map(({ x, y }) => ({ x, y }));
  strategyCase.options.generations = 0;

  minimizeLayout(strategyCase.options);

  expect(strategyCase.options.nodes.map(({ x, y }) => ({ x, y }))).toEqual(
    before,
  );
  expect(strategyCase.frames).toEqual([]);
});

test("minimizeLayout retains angular relaxation through its strategy cycle", () => {
  const strategyCase = createStrategyCase("angular-relaxation");
  const before = angularRelaxationScore(strategyCase.options.edges);

  minimizeLayout(strategyCase.options);

  expect(angularRelaxationScore(strategyCase.options.edges)).toBeLessThan(
    before,
  );
  expect(strategyCase.options.isValid(true)).toBe(true);
});

test("minimizeLayout runs swaps before other geometry stages", () => {
  const strategyCase = createStrategyCase("node-swap-boundary");

  minimizeLayout(strategyCase.options);

  const swapIndex = strategyCase.frames.findIndex(
    (frame) => frame.strategy === "node-swap",
  );
  expect(swapIndex).toBeGreaterThanOrEqual(0);
  expect(
    strategyCase.frames
      .slice(0, swapIndex)
      .every((frame) => frame.strategy === "disconnected-perimeter"),
  ).toBe(true);
  expect(strategyCase.options.isValid(true)).toBe(true);
});

test("minimizeLayout never increases aggregate element area", () => {
  const strategyCase = createStrategyCase("element-alignment");
  const before = strategyCase.options.elementAreaScore!();

  minimizeLayout(strategyCase.options);

  expect(strategyCase.options.elementAreaScore!()).toBeLessThanOrEqual(before);
  expect(strategyCase.options.isValid(true)).toBe(true);
});
