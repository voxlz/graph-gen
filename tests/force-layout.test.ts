import { applyForceLayout } from "../src/force-layout";
import type { LayoutNode } from "../src/layout";

function smallestAngularGap(hub: LayoutNode, neighbors: LayoutNode[]): number {
  const angles = neighbors
    .map((node) => Math.atan2(node.y - hub.y, node.x - hub.x))
    .sort((first, second) => first - second);
  return Math.min(
    ...angles.map(
      (angle, index) =>
        (angles[(index + 1) % angles.length] - angle + Math.PI * 2) %
        (Math.PI * 2),
    ),
  );
}

test("force layout separates crowded incident edge angles", () => {
  const nodes: LayoutNode[] = ["a", "b", "c", "d", "e", "hub"].map((id) => ({
    id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    boundaryParent: null,
  }));
  const hub = nodes.find((node) => node.id === "hub")!;
  const neighbors = nodes.filter((node) => ["a", "b", "c"].includes(node.id));

  const snapshots = applyForceLayout(
    nodes,
    [],
    neighbors.map((node) => ({ source: hub, target: node })),
    {
      iterations: 1,
      nodeGap: 0,
      linkLength: 100,
      nodeRepulsion: 0,
      boundaryRepulsion: 0,
      edgeAttraction: 0,
      siblingAttraction: 0,
      crossingRepulsion: 0,
      angularSeparation: 1,
      edgePressure: 0,
      step: 1,
      minimumStep: 0,
      damping: 0,
      convergenceThreshold: 0,
      stableIterations: 1,
      collisionRampIterations: 1,
      debugFrameEvery: 1,
    },
  );

  expect(smallestAngularGap(hub, neighbors)).toBeGreaterThan(Math.PI / 9);
  expect(snapshots.map((snapshot) => snapshot.phase)).toEqual([
    "force",
    "force",
  ]);
  expect(snapshots.map((snapshot) => snapshot.iteration)).toEqual([0, 1]);
});

test("force layout permits early overlap while connected nodes exchange sides", () => {
  const nodes: LayoutNode[] = ["cache", "catalog"].map((id) => ({
    id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    boundaryParent: null,
  }));
  const [cache, catalog] = nodes;
  const initialDistance = 20;

  applyForceLayout(nodes, [], [{ source: cache, target: catalog }], {
    iterations: 1,
    nodeGap: 10,
    linkLength: 1,
    nodeRepulsion: 1.4,
    boundaryRepulsion: 0,
    edgeAttraction: 0.08,
    siblingAttraction: 0,
    crossingRepulsion: 0,
    angularSeparation: 0,
    edgePressure: 0,
    step: 10,
    minimumStep: 0,
    damping: 0,
    convergenceThreshold: 0,
    stableIterations: 1,
    collisionRampIterations: 10,
  });

  expect(Math.abs(catalog.x - cache.x)).toBeLessThan(initialDistance);
});

test("edge pressure does not move connected edge siblings", () => {
  const nodes: LayoutNode[] = ["a", "b"].map((id) => ({
    id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    boundaryParent: null,
  }));
  const [a, b] = nodes;

  applyForceLayout(nodes, [], [{ source: a, target: b }], {
    iterations: 1,
    nodeGap: 10,
    linkLength: 100,
    nodeRepulsion: 0,
    boundaryRepulsion: 0,
    edgeAttraction: 0,
    siblingAttraction: 0,
    crossingRepulsion: 0,
    angularSeparation: 0,
    edgePressure: 3.5,
    step: 10,
    minimumStep: 0,
    damping: 0,
    convergenceThreshold: 0,
    stableIterations: 1,
    collisionRampIterations: 1,
  });

  expect(Math.abs(b.x - a.x)).toBe(20);
});

test("edge pressure always pulls a loose node away from its boundary edge", () => {
  const nodes: LayoutNode[] = [
    { id: "a", x: 0, y: 0, width: 10, height: 10, boundaryParent: null },
    { id: "b", x: 0, y: 0, width: 10, height: 10, boundaryParent: null },
    { id: "z", x: 0, y: 0, width: 10, height: 10, boundaryParent: null },
  ];
  const [a, b, loose] = nodes;

  applyForceLayout(nodes, [], [{ source: a, target: b }], {
    iterations: 1,
    nodeGap: 10,
    linkLength: 100,
    nodeRepulsion: 0,
    boundaryRepulsion: 0,
    edgeAttraction: 0,
    siblingAttraction: 0,
    crossingRepulsion: 0,
    angularSeparation: 0,
    edgePressure: 3.5,
    step: 10,
    minimumStep: 0,
    damping: 0,
    convergenceThreshold: 0,
    stableIterations: 1,
    collisionRampIterations: 1,
  });

  expect(loose.y).toBeLessThan(20);
});

test("sibling attraction stops at collision clearance", () => {
  const nodes: LayoutNode[] = ["a", "b"].map((id) => ({
    id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    boundaryParent: null,
  }));
  const [a, b] = nodes;

  applyForceLayout(nodes, [], [], {
    iterations: 50,
    nodeGap: 10,
    linkLength: 100,
    nodeRepulsion: 1.4,
    boundaryRepulsion: 0,
    edgeAttraction: 0,
    siblingAttraction: 1,
    crossingRepulsion: 0,
    angularSeparation: 0,
    edgePressure: 0,
    step: 2,
    minimumStep: 0.01,
    damping: 0.2,
    convergenceThreshold: 0,
    stableIterations: 1,
    collisionRampIterations: 1,
  });

  expect(Math.abs(b.x - a.x)).toBeGreaterThanOrEqual(20);
});
