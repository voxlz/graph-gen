import { minimizeDisconnectedPerimeter } from "../../src/strategies/disconnected-perimeter";
import { compactness } from "../../src/strategies/shared";
import { createStrategyCase } from "./fixture";

test("disconnected-perimeter strategy relocates a free node to a tighter slot", () => {
  const strategyCase = createStrategyCase("disconnected-perimeter");
  const before = compactness(strategyCase.options.measure()!);
  const attacker = strategyCase.options.nodes.find(
    (node) => node.id === "attacker",
  )!;
  const initialPosition = { x: attacker.x, y: attacker.y };

  expect(
    minimizeDisconnectedPerimeter(strategyCase.options, before.area * 1.05),
  ).toBe(true);

  const after = compactness(strategyCase.options.measure()!);
  expect({ x: attacker.x, y: attacker.y }).not.toEqual(initialPosition);
  expect(after.area).toBeLessThan(before.area);
  expect(strategyCase.frames).toHaveLength(1);
  expect(strategyCase.frames[0].strategy).toBe("disconnected-perimeter");
});
