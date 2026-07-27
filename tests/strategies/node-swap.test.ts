import { minimizeNodeSwaps } from "../../src/strategies/node-swap";
import { compactness } from "../../src/strategies/shared";
import { createStrategyCase } from "./fixture";

test("node-swap strategy atomically swaps peers in the same container", () => {
  const strategyCase = createStrategyCase("node-swap");
  expect(strategyCase.options.isValid(true)).toBe(true);
  const before = compactness(strategyCase.options.measure()!);

  expect(minimizeNodeSwaps(strategyCase.options, before.area)).toBe(true);

  const after = compactness(strategyCase.options.measure()!);
  expect(
    strategyCase.options.nodes.find((node) => node.id === "first")?.x,
  ).toBe(800);
  expect(
    strategyCase.options.nodes.find((node) => node.id === "second")?.x,
  ).toBe(0);
  expect(after.edgeLength).toBeLessThan(before.edgeLength);
  expect(strategyCase.options.isValid(true)).toBe(true);
  expect(strategyCase.frames).toHaveLength(1);
  expect(strategyCase.frames[0].strategy).toBe("node-swap");
});
