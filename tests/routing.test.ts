import {
  bendToLabels,
  placeRouteLabels,
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

  it("bends into the layout rather than out of it", () => {
    // A fourth node above the row makes room above; below is outside.
    const [route] = routeCurved({
      ...blocked,
      nodes: [...blocked.nodes, { x: 200, y: -200, width: 100, height: 60 }],
    });
    expect(hitsMiddle(route.points)).toBe(false);
    expect(Math.max(...route.points.map((p) => p.y))).toBeLessThanOrEqual(30);
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

describe("placeRouteLabels", () => {
  const nodes = [
    { x: 0, y: 0, width: 100, height: 60 },
    { x: 400, y: 0, width: 100, height: 60 },
  ];

  it("centres a label on its own edge", () => {
    const input: RouteInput = {
      nodes,
      edges: [{ source: 0, target: 1, labelWidth: 60, labelHeight: 16 }],
      groups: [],
      clearance: 8,
    };
    const [spot] = placeRouteLabels(input, routeCurved(input));
    expect(spot!.x).toBeCloseTo(200);
    expect(spot!.y).toBeCloseTo(0);
  });

  it("routes an edge through its label node and keeps the label there", () => {
    const via = { x: 200, y: 60 };
    const input: RouteInput = {
      nodes,
      edges: [{ source: 0, target: 1, labelWidth: 60, labelHeight: 16, via }],
      groups: [],
      clearance: 8,
    };
    const routes = routeCurved(input);
    const { p0, c, p2 } = routes[0].curve!;
    const onCurve = Array.from({ length: 201 }, (_, i) => {
      const t = i / 200;
      const u = 1 - t;
      return {
        x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x,
        y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y,
      };
    }).some((p) => Math.hypot(p.x - via.x, p.y - via.y) < 1);
    expect(onCurve).toBe(true);
    const [spot] = placeRouteLabels(input, routes);
    expect(spot).toMatchObject(via);
  });

  it("bends an edge to a label that can't fit beside it", () => {
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 90, height: 90 },
        { x: 200, y: 0, width: 120, height: 90 },
      ],
      edges: [{ source: 0, target: 1, labelWidth: 350, labelHeight: 32 }],
      groups: [],
      clearance: 8,
    };
    const routes = routeCurved(input);
    const spots = placeRouteLabels(input, routes);
    expect(spots[0]!.detached).toBe(true);
    const [route] = bendToLabels(input, routes, spots);
    const box = {
      minX: spots[0]!.x - 175 - 4,
      maxX: spots[0]!.x + 175 + 4,
      minY: spots[0]!.y - 16 - 2,
      maxY: spots[0]!.y + 16 + 2,
    };
    const pts = route.points;
    expect(pts.slice(1).some((p, i) => segmentHitsBox(pts[i], p, box))).toBe(
      true,
    );
  });

  it("keeps a wide label's middle on its edge when moving it aside", () => {
    // A vertical edge with a parallel edge close by: centred, the 300px label
    // would cross the other edge, so it moves aside, but not so far that its
    // own edge only grazes its border.
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 90, height: 60 },
        { x: 0, y: 200, width: 90, height: 60 },
        { x: -130, y: 0, width: 90, height: 60 },
        { x: -130, y: 200, width: 90, height: 60 },
      ],
      edges: [
        { source: 0, target: 1, labelWidth: 300, labelHeight: 16 },
        { source: 2, target: 3 },
      ],
      groups: [],
      clearance: 8,
    };
    const routes = routeCurved(input);
    const [spot] = placeRouteLabels(input, routes);
    expect(spot!.detached).toBeUndefined();
    expect(Math.abs(spot!.x)).toBeLessThan(154 / 2 + 1);
    expect(spot!.x).toBeGreaterThan(-130 + 154);
  });

  it("moves a label off another edge without touching it", () => {
    const input: RouteInput = {
      nodes: [
        ...nodes,
        { x: 200, y: -200, width: 100, height: 60 },
        { x: 200, y: 200, width: 100, height: 60 },
      ],
      edges: [
        { source: 0, target: 1, labelWidth: 60, labelHeight: 16 },
        { source: 2, target: 3 },
      ],
      groups: [],
      clearance: 8,
    };
    const routes = routeCurved(input);
    const [spot] = placeRouteLabels(input, routes);
    const box = {
      minX: spot!.x - 30 - 6,
      maxX: spot!.x + 30 + 6,
      minY: spot!.y - 8 - 4,
      maxY: spot!.y + 8 + 4,
    };
    const other = routes[1].points;
    expect(
      other.slice(1).some((p, i) => segmentHitsBox(other[i], p, box)),
    ).toBe(false);
    // Clear of every node by at least an arrowhead (10px).
    for (const node of input.nodes) {
      expect(
        box.maxX < node.x - node.width / 2 - 10 ||
          box.minX > node.x + node.width / 2 + 10 ||
          box.maxY < node.y - node.height / 2 - 10 ||
          box.minY > node.y + node.height / 2 + 10,
      ).toBe(true);
    }
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
