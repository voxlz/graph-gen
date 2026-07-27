import { minimizeBlockerEscapes } from "../../src/strategies/blocker-escape";
import { compactness } from "../../src/strategies/shared";
import { createStrategyCase } from "./fixture";

test("blocker-escape strategy moves around a static obstacle", () => {
  const strategyCase = createStrategyCase("blocker-escape");
  expect(strategyCase.options.isValid(true)).toBe(true);
  const before = compactness(strategyCase.options.measure()!);
  const initialPositions = new Map(
    strategyCase.options.nodes.map((node) => [
      node.id,
      { x: node.x, y: node.y },
    ]),
  );

  expect(minimizeBlockerEscapes(strategyCase.options, before.area * 1.05)).toBe(
    true,
  );

  const after = compactness(strategyCase.options.measure()!);
  const movedPerpendicularly = strategyCase.options.nodes.some((node) => {
    const initial = initialPositions.get(node.id)!;
    return initial.y === 0 && node.y !== initial.y;
  });
  expect(movedPerpendicularly).toBe(true);
  expect(after.area).toBeLessThan(before.area);
  expect(strategyCase.options.isValid(true)).toBe(true);
  expect(
    strategyCase.frames.every((frame) => frame.strategy === "blocker-escape"),
  ).toBe(true);
});
