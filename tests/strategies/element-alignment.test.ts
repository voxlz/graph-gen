import { minimizeElementAlignment } from "../../src/strategies/element-alignment";
import { measureBounds, nodeRect } from "../../src/strategies/shared";
import { createStrategyCase, fixtureBoundaryRects } from "./fixture";

function area(rect: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): number {
  return (rect.maxX - rect.minX) * (rect.maxY - rect.minY);
}

test("element alignment compacts boundaries and the graph root", () => {
  const strategyCase = createStrategyCase("element-alignment");
  const regionArea = (id: string | null): number => {
    if (id) {
      return area(
        fixtureBoundaryRects(
          strategyCase.fixture,
          strategyCase.options.nodes,
        ).find((boundary) => boundary.id === id)!,
      );
    }
    return area(
      measureBounds([
        ...strategyCase.options.nodes
          .filter((node) => node.boundaryParent === null)
          .map(nodeRect),
        ...fixtureBoundaryRects(
          strategyCase.fixture,
          strategyCase.options.nodes,
        ).filter((boundary) =>
          strategyCase.fixture.boundaries.some(
            (definition) => definition.id === boundary.id && !definition.parent,
          ),
        ),
      ])!,
    );
  };
  const beforeLan = regionArea("lan");
  const beforeRoot = regionArea(null);

  expect(minimizeElementAlignment(strategyCase.options)).toBe(true);

  expect(regionArea("lan")).toBeLessThan(beforeLan);
  expect(regionArea(null)).toBeLessThan(beforeRoot);
  expect(strategyCase.options.isValid(true)).toBe(true);
  expect(
    strategyCase.frames.every(
      (frame) => frame.strategy === "element-alignment",
    ),
  ).toBe(true);
});

test("uses sibling boundary alignments to reduce their parent boundary", () => {
  const strategyCase = createStrategyCase("element-alignment-boundaries");
  const before = fixtureBoundaryRects(
    strategyCase.fixture,
    strategyCase.options.nodes,
  );
  const beforeParent = area(
    before.find((boundary) => boundary.id === "internal")!,
  );

  expect(minimizeElementAlignment(strategyCase.options)).toBe(true);

  const after = fixtureBoundaryRects(
    strategyCase.fixture,
    strategyCase.options.nodes,
  );
  expect(
    area(after.find((boundary) => boundary.id === "internal")!),
  ).toBeLessThan(beforeParent);
  expect(strategyCase.options.isValid(true)).toBe(true);
});

test("uses boundary-to-node alignments to reduce their parent boundary", () => {
  const strategyCase = createStrategyCase("element-alignment-boundary-node");
  const beforeParent = fixtureBoundaryRects(
    strategyCase.fixture,
    strategyCase.options.nodes,
  ).find((boundary) => boundary.id === "internal")!;

  expect(minimizeElementAlignment(strategyCase.options)).toBe(true);

  const parent = fixtureBoundaryRects(
    strategyCase.fixture,
    strategyCase.options.nodes,
  ).find((boundary) => boundary.id === "internal")!;
  expect(area(parent)).toBeLessThan(area(beforeParent));
  expect(strategyCase.options.isValid(true)).toBe(true);
});
