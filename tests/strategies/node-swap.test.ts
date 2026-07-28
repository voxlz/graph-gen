import { minimizeNodeSwaps } from "../../src/strategies/node-swap";
import { compactness, nodeRect } from "../../src/strategies/shared";
import { createStrategyCase, fixtureBoundaryRects } from "./fixture";

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

test("node-swap strategy swaps a node with a sibling boundary", () => {
  const strategyCase = createStrategyCase("node-swap-boundary");
  const before = compactness(strategyCase.options.measure()!);
  const beforeNode = strategyCase.options.nodes.find(
    (node) => node.id === "attacker",
  )!;
  const beforeBoundary = fixtureBoundaryRects(
    strategyCase.fixture,
    strategyCase.options.nodes,
  ).find((boundary) => boundary.id === "inner")!;
  const beforeExtent = {
    minY: Math.min(nodeRect(beforeNode).minY, beforeBoundary.minY),
    maxY: Math.max(nodeRect(beforeNode).maxY, beforeBoundary.maxY),
  };

  expect(minimizeNodeSwaps(strategyCase.options, before.area)).toBe(true);

  const nodeById = new Map(
    strategyCase.options.nodes.map((node) => [node.id, node]),
  );
  expect(nodeById.get("attacker")?.y).toBe(640);
  expect(nodeById.get("node2")?.y).toBe(290);
  expect(nodeById.get("node3")?.y).toBe(390);
  const afterNode = nodeById.get("attacker")!;
  const afterBoundary = fixtureBoundaryRects(
    strategyCase.fixture,
    strategyCase.options.nodes,
  ).find((boundary) => boundary.id === "inner")!;
  expect({
    minY: Math.min(nodeRect(afterNode).minY, afterBoundary.minY),
    maxY: Math.max(nodeRect(afterNode).maxY, afterBoundary.maxY),
  }).toEqual(beforeExtent);
  expect(strategyCase.options.measure()!.edgeLength).toBeLessThan(
    before.edgeLength,
  );
  expect(strategyCase.options.isValid(true)).toBe(true);
});
