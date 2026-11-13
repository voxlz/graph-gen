import {
  routeCurved,
  routeOrthogonal,
  segmentHitsBox,
  type RouteInput,
} from "../src/routing";

// Three nodes in a row: an edge from the left to the right node must bend
// around the node in the middle instead of passing through it.
const blocked: RouteInput = {
  nodes: [
    { x: 0, y: 0, width: 100, height: 60 },
    { x: 200, y: 0, width: 100, height: 60 },
    { x: 400, y: 0, width: 100, height: 60 },
  ],
  edges: [{ source: 0, target: 2 }],
  groups: [],
  clearance: 8,
};
const middle = { minX: 150, maxX: 250, minY: -30, maxY: 30 };

function hitsMiddle(points: Array<{ x: number; y: number }>) {
  return points.slice(1).some((p, i) => segmentHitsBox(points[i], p, middle));
}

describe("routeCurved", () => {
  it("bends a single curve around a node in the way", () => {
    const [route] = routeCurved(blocked);
    expect(route.curve).toBeDefined();
    expect(hitsMiddle(route.points)).toBe(false);
  });

  it("keeps an unobstructed edge straight", () => {
    const [route] = routeCurved({
      ...blocked,
      edges: [{ source: 0, target: 1 }],
    });
    const ys = route.points.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-6);
  });
});

describe("routeOrthogonal", () => {
  it("routes around a node using only horizontal and vertical segments", () => {
    const [route] = routeOrthogonal(blocked);
    expect(hitsMiddle(route.points)).toBe(false);
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1];
      const b = route.points[i];
      expect(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6).toBe(
        true,
      );
    }
    // Starts on the source border and ends on the target border.
    const onBorder = (
      p: { x: number; y: number },
      node: (typeof blocked.nodes)[number],
    ) => {
      const dx = Math.abs(p.x - node.x) - node.width / 2;
      const dy = Math.abs(p.y - node.y) - node.height / 2;
      return Math.abs(Math.max(dx, dy)) < 1e-6;
    };
    expect(onBorder(route.points[0], blocked.nodes[0])).toBe(true);
    expect(
      onBorder(route.points[route.points.length - 1], blocked.nodes[2]),
    ).toBe(true);
  });

  it("avoids boundaries that contain neither endpoint", () => {
    const [route] = routeOrthogonal({
      ...blocked,
      nodes: [blocked.nodes[0], blocked.nodes[2]],
      edges: [{ source: 0, target: 1 }],
      groups: [{ rect: middle, members: new Set() }],
    });
    expect(hitsMiddle(route.points)).toBe(false);
  });
});
