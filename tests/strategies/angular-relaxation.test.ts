import {
  angularRelaxationScore,
  minimizeAngularRelaxation,
} from "../../src/strategies/angular-relaxation";
import { compactness } from "../../src/strategies/shared";
import { createStrategyCase } from "./fixture";

test("angular relaxation spreads clustered edges around their hub", () => {
  const strategyCase = createStrategyCase("angular-relaxation");
  expect(strategyCase.options.isValid(true)).toBe(true);
  const before = compactness(strategyCase.options.measure()!);
  const beforeAngularScore = angularRelaxationScore(strategyCase.options.edges);
  const hub = strategyCase.options.nodes.find((node) => node.id === "hub")!;
  const radii = new Map(
    strategyCase.options.nodes
      .filter((node) => node !== hub)
      .map((node) => [node.id, Math.hypot(node.x - hub.x, node.y - hub.y)]),
  );

  expect(
    minimizeAngularRelaxation(strategyCase.options, before.area * 1.05),
  ).toBe(true);

  expect(angularRelaxationScore(strategyCase.options.edges)).toBeLessThan(
    beforeAngularScore,
  );
  const angles = strategyCase.options.nodes
    .filter((node) => node !== hub)
    .map(
      (node) =>
        ((Math.atan2(node.y - hub.y, node.x - hub.x) * 180) / Math.PI + 360) %
        360,
    )
    .sort((first, second) => first - second);
  const gaps = angles.map(
    (angle, index) => (angles[(index + 1) % angles.length] - angle + 360) % 360,
  );
  const sortedGaps = gaps.sort((first, second) => first - second);
  expect(sortedGaps[0]).toBeCloseTo(40, 1);
  expect(sortedGaps[1]).toBeCloseTo(40, 1);
  expect(sortedGaps[2]).toBeCloseTo(280, 1);
  for (const node of strategyCase.options.nodes.filter(
    (node) => node !== hub,
  )) {
    expect(Math.hypot(node.x - hub.x, node.y - hub.y)).toBeLessThanOrEqual(
      radii.get(node.id)! + 0.01,
    );
  }
  expect(strategyCase.options.isValid(true)).toBe(true);
  expect(strategyCase.frames[0].strategy).toBe("angular-relaxation");
});

test("angular relaxation moves a free neighbor when its siblings are locked", () => {
  const strategyCase = createStrategyCase("angular-relaxation");
  const locked = strategyCase.options.nodes.filter((node) =>
    ["a", "b"].includes(node.id),
  );
  const lockedPositions = locked.map(({ x, y }) => ({ x, y }));
  const free = strategyCase.options.nodes.find((node) => node.id === "free")!;
  const freePosition = { x: free.x, y: free.y };
  const baselineScore = angularRelaxationScore(strategyCase.options.edges);
  const baselineMeasure = strategyCase.options.measure()!;
  const isValid = strategyCase.options.isValid;
  strategyCase.options.isValid = (includeLabels) =>
    isValid(includeLabels) &&
    locked.every(
      (node, index) =>
        node.x === lockedPositions[index].x &&
        node.y === lockedPositions[index].y,
    );

  expect(
    minimizeAngularRelaxation(
      strategyCase.options,
      compactness(baselineMeasure).area * 1.05,
    ),
  ).toBe(true);

  expect(locked.map(({ x, y }) => ({ x, y }))).toEqual(lockedPositions);
  expect({ x: free.x, y: free.y }).not.toEqual(freePosition);
  expect(angularRelaxationScore(strategyCase.options.edges)).toBeLessThan(
    baselineScore,
  );
  expect(strategyCase.options.isValid(true)).toBe(true);
});

test("angular relaxation rolls back a generation outside its area budget", () => {
  const strategyCase = createStrategyCase("angular-relaxation");
  const before = strategyCase.options.nodes.map(({ x, y }) => ({ x, y }));
  const beforeScore = angularRelaxationScore(strategyCase.options.edges);

  expect(minimizeAngularRelaxation(strategyCase.options, 1)).toBe(false);

  expect(strategyCase.options.nodes.map(({ x, y }) => ({ x, y }))).toEqual(
    before,
  );
  expect(angularRelaxationScore(strategyCase.options.edges)).toBe(beforeScore);
  expect(strategyCase.frames).toEqual([]);
});
