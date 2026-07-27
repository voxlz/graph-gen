import { minimizeSharedNeighborSpread } from "../../src/strategies/shared-neighbor-spread";
import { compactness } from "../../src/strategies/shared";
import { createStrategyCase } from "./fixture";

test("shared-neighbor spread equalizes blocked siblings around their hub", () => {
  const strategyCase = createStrategyCase("shared-neighbor-spread");
  expect(strategyCase.options.isValid(true)).toBe(true);
  const before = compactness(strategyCase.options.measure()!);

  expect(
    minimizeSharedNeighborSpread(strategyCase.options, before.area * 1.05),
  ).toBe(true);

  const hub = strategyCase.options.nodes.find((node) => node.id === "hub")!;
  const near = strategyCase.options.nodes.find((node) => node.id === "near")!;
  const far = strategyCase.options.nodes.find((node) => node.id === "far")!;
  const nearRadius = Math.hypot(near.x - hub.x, near.y - hub.y);
  const farRadius = Math.hypot(far.x - hub.x, far.y - hub.y);
  expect(nearRadius).toBeCloseTo(farRadius, 6);
  expect(compactness(strategyCase.options.measure()!).edgeLength).toBeLessThan(
    before.edgeLength,
  );
  expect(strategyCase.options.isValid(true)).toBe(true);
  expect(strategyCase.frames[0].strategy).toBe("shared-neighbor-spread");
});
