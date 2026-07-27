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

test("node-swap strategy swaps peers across different containers", () => {
  const strategyCase = createStrategyCase("node-swap-cross-container");
  expect(strategyCase.options.isValid(true)).toBe(true);
  const before = compactness(strategyCase.options.measure()!);

  expect(minimizeNodeSwaps(strategyCase.options, before.area)).toBe(true);

  const nodeById = new Map(
    strategyCase.options.nodes.map((node) => [node.id, node]),
  );
  expect(nodeById.get("remote")).toMatchObject({ x: 0, y: 200 });
  expect(nodeById.get("idle")).toMatchObject({ x: 600, y: 0 });
  expect(nodeById.get("remote")?.boundaryParent).toBe("outer");
  expect(nodeById.get("idle")?.boundaryParent).toBeNull();

  const after = compactness(strategyCase.options.measure()!);
  expect(after.edgeLength).toBeLessThan(before.edgeLength);
  expect(strategyCase.options.isValid(true)).toBe(true);
});
