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

test("minimizeLayout runs node and boundary swaps before geometry stages", () => {
  const strategyCase = createStrategyCase("node-swap-boundary");

  minimizeLayout(strategyCase.options);

  expect(strategyCase.frames[0]?.strategy).toBe("node-swap");
  expect(strategyCase.options.isValid(true)).toBe(true);
});

test("minimizeLayout never increases aggregate element area", () => {
  const strategyCase = createStrategyCase("element-alignment");
  const before = strategyCase.options.elementAreaScore!();

  minimizeLayout(strategyCase.options);

  expect(strategyCase.options.elementAreaScore!()).toBeLessThanOrEqual(before);
  expect(strategyCase.options.isValid(true)).toBe(true);
});
