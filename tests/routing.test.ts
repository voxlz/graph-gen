import {
  bendToLabels,
  bendOrthogonalToLabels,
  clipOrthogonalToNodeShapes,
  nodeBoundaryPoint,
  placeRouteLabels,
  routeCurved,
  routeOrthogonal,
  routeTouchesLabel,
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

describe("rounded node endpoints", () => {
  const node = { x: 0, y: 0, width: 120, height: 60, borderRadius: 30 };

  it("clips diagonal straight edges to the rounded outline", () => {
    const point = nodeBoundaryPoint(node, { x: 200, y: 100 });
    expect(point.x).toBeCloseTo(48);
    expect(point.y).toBeCloseTo(24);
  });

  it("extends orthogonal endpoints without changing their direction", () => {
    const route = {
      points: [
        { x: 60, y: 25 },
        { x: 150, y: 25 },
        { x: 150, y: 200 },
      ],
    };
    const target = { x: 150, y: 230, width: 60, height: 60 };
    const clipped = clipOrthogonalToNodeShapes(route, node, target);
    expect(clipped.points[0].x).toBeCloseTo(30 + Math.sqrt(275));
    expect(clipped.points[0].y).toBe(25);
    expect(clipped.points.slice(1)).toEqual(route.points.slice(1));
  });

  it("clips both ends of a centre-to-centre orthogonal fallback", () => {
    const target = { x: 200, y: 100, width: 60, height: 60, borderRadius: 30 };
    const clipped = clipOrthogonalToNodeShapes(
      {
        points: [
          { x: 0, y: 0 },
          { x: 200, y: 100 },
        ],
      },
      node,
      target,
    );
    expect(clipped.points[0].x).toBeCloseTo(48);
    expect(
      Math.hypot(
        clipped.points[1].x - target.x,
        clipped.points[1].y - target.y,
      ),
    ).toBeCloseTo(30);
  });

  it("clips diagonal edges to a cylinder's elliptical cap", () => {
    const cylinder = { ...node, outline: "cylinder" as const };
    const point = nodeBoundaryPoint(cylinder, { x: 200, y: 100 });
    const rx = cylinder.width / 2;
    const ry = cylinder.height * 0.16;
    const capY = point.y - (cylinder.height / 2 - ry);
    expect(capY).toBeGreaterThan(0);
    expect((point.x / rx) ** 2 + (capY / ry) ** 2).toBeCloseTo(1);
  });
});

describe("routeCurved", () => {
  it("clips both ends of a curve to rounded outlines", () => {
    const nodes = [
      { x: 0, y: 0, width: 120, height: 60, borderRadius: 30 },
      { x: 200, y: 100, width: 60, height: 60, borderRadius: 30 },
    ];
    const [route] = routeCurved({
      nodes,
      edges: [{ source: 0, target: 1 }],
      groups: [],
      clearance: 8,
    });
    expect(route.curve!.p0.x).toBeCloseTo(48, 4);
    expect(route.curve!.p0.y).toBeCloseTo(24, 4);
    expect(
      Math.hypot(route.curve!.p2.x - 200, route.curve!.p2.y - 100),
    ).toBeCloseTo(30, 4);
    expect(route.points[0]).toEqual(route.curve!.p0);
    expect(route.points[route.points.length - 1]).toEqual(route.curve!.p2);
  });

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

  it("keeps orthogonal bends visible without changing curved label placement", () => {
    const input: RouteInput = {
      nodes: [nodes[0], { x: 200, y: 180, width: 100, height: 60 }],
      edges: [{ source: 0, target: 1, labelWidth: 80, labelHeight: 16 }],
      groups: [],
      clearance: 8,
    };
    const routes = [
      {
        points: [
          { x: 50, y: 0 },
          { x: 200, y: 0 },
          { x: 200, y: 150 },
        ],
      },
    ];
    const legacy = placeRouteLabels(input, routes);
    expect(legacy[0]).toMatchObject({ x: 200, y: 0 });
    expect(placeRouteLabels(input, routes, "curved")).toEqual(legacy);
    const [spot] = placeRouteLabels(input, routes, "orthogonal");
    expect(spot!.blocked).toBeUndefined();
    expect(spot!.detached).toBeUndefined();
    // Include the label padding and breathing room around the corner.
    const hidesBend =
      Math.abs(spot!.x - 200) < 40 + 4 + 10 && Math.abs(spot!.y) < 8 + 2 + 10;
    expect(hidesBend).toBe(false);
  });
});

describe("routeOrthogonal", () => {
  it("removes redundant doglegs even when the route already touches its label", () => {
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 400, y: 200, width: 100, height: 60 },
      ],
      edges: [{ source: 0, target: 1, labelWidth: 80, labelHeight: 16 }],
      groups: [],
      clearance: 8,
    };
    const spot = { x: 200, y: 100, anchorX: 200, anchorY: 100 };
    const [route] = bendOrthogonalToLabels(
      input,
      [
        {
          points: [
            { x: 50, y: 0 },
            { x: 120, y: 0 },
            { x: 120, y: 60 },
            { x: 200, y: 60 },
            { x: 200, y: 140 },
            { x: 280, y: 140 },
            { x: 280, y: 200 },
            { x: 350, y: 200 },
          ],
        },
      ],
      [spot],
    );
    expect(route.points).toEqual([
      { x: 50, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 350, y: 200 },
    ]);
    expect(routeTouchesLabel(route, spot, 80, 16)).toBe(true);
  });

  it("keeps parallel sections off a group border while allowing crossings", () => {
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 400, y: 200, width: 100, height: 60 },
      ],
      edges: [{ source: 0, target: 1 }],
      groups: [
        {
          rect: { minX: 200, minY: 100, maxX: 500, maxY: 300 },
          members: new Set([1]),
        },
      ],
      clearance: 8,
    };
    const [{ points }] = routeOrthogonal(input);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (
        Math.abs(a.x - b.x) < 1e-6 &&
        Math.max(a.y, b.y) > 100 &&
        Math.min(a.y, b.y) < 300
      ) {
        expect(
          Math.min(Math.abs(a.x - 200), Math.abs(a.x - 500)),
        ).toBeGreaterThanOrEqual(6 - 1e-6);
      }
      if (
        Math.abs(a.y - b.y) < 1e-6 &&
        Math.max(a.x, b.x) > 200 &&
        Math.min(a.x, b.x) < 500
      ) {
        expect(
          Math.min(Math.abs(a.y - 100), Math.abs(a.y - 300)),
        ).toBeGreaterThanOrEqual(6 - 1e-6);
      }
    }
    expect(points[0]).toMatchObject({ x: 50, y: 0 });
    const end = points.at(-1)!;
    expect(
      (end.x === 350 && end.y === 200) || (end.x === 400 && end.y === 170),
    ).toBe(true);
  });

  it("keeps aligned endpoints straight through an off-center label node", () => {
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 0, y: 400, width: 100, height: 60 },
      ],
      edges: [
        {
          source: 0,
          target: 1,
          via: { x: 4, y: 200 },
          labelWidth: 100,
          labelHeight: 20,
        },
      ],
      groups: [],
      clearance: 8,
    };
    const [route] = routeOrthogonal(input);
    expect(route.points).toHaveLength(2);
    expect(route.points.every((point) => point.x === 0)).toBe(true);
    expect(routeTouchesLabel(route, input.edges[0].via!, 100, 20)).toBe(true);
  });

  describe("group title obstacles", () => {
    it.each(["curved", "orthogonal"] as const)(
      "keeps %s edges and edge labels clear of their own group's title",
      (mode) => {
        const label = { minX: -54, maxX: 180, minY: -76, maxY: -54 };
        const input: RouteInput = {
          nodes: [
            { x: 0, y: 0, width: 100, height: 60 },
            { x: 0, y: -200, width: 100, height: 60 },
          ],
          edges: [{ source: 0, target: 1, labelWidth: 100, labelHeight: 16 }],
          groups: [
            {
              rect: { minX: -60, maxX: 460, minY: -80, maxY: 160 },
              members: new Set([0]),
              label,
            },
          ],
          clearance: 8,
        };
        const routes =
          mode === "curved" ? routeCurved(input) : routeOrthogonal(input);
        const [spot] = placeRouteLabels(input, routes, mode);
        expect(
          routes[0].points
            .slice(1)
            .some((point, i) =>
              segmentHitsBox(routes[0].points[i], point, label),
            ),
        ).toBe(false);
        expect(
          spot!.x + 54 <= label.minX ||
            spot!.x - 54 >= label.maxX ||
            spot!.y + 10 <= label.minY ||
            spot!.y - 10 >= label.maxY,
        ).toBe(true);
      },
    );
  });

  it("routes through a label node without turning behind it", () => {
    const via = { x: 100, y: 120 };
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 200, y: 0, width: 100, height: 60 },
      ],
      edges: [{ source: 0, target: 1, via, labelWidth: 180, labelHeight: 16 }],
      groups: [],
      clearance: 8,
    };
    const [route] = routeOrthogonal(input);
    expect(routeTouchesLabel(route, via, 180, 16)).toBe(true);
    expect(
      route.points
        .slice(1, -1)
        .some(
          (p) =>
            Math.abs(p.x - via.x) < 104 - 1e-6 &&
            Math.abs(p.y - via.y) < 20 - 1e-6,
        ),
    ).toBe(false);
    for (let i = 1; i < route.points.length; i++) {
      expect(
        route.points[i].x === route.points[i - 1].x ||
          route.points[i].y === route.points[i - 1].y,
      ).toBe(true);
    }
  });

  it("keeps other edges clear of label nodes", () => {
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 60, height: 60 },
        { x: 400, y: 0, width: 60, height: 60 },
        { x: 200, y: -200, width: 60, height: 60 },
        { x: 200, y: 200, width: 60, height: 60 },
      ],
      edges: [
        {
          source: 0,
          target: 1,
          via: { x: 200, y: 0 },
          labelWidth: 100,
          labelHeight: 20,
        },
        { source: 2, target: 3 },
      ],
      groups: [],
      clearance: 8,
    };
    const routes = routeOrthogonal(input);
    expect(routeTouchesLabel(routes[0], input.edges[0].via!, 100, 20)).toBe(
      true,
    );
    const label = { minX: 146, maxX: 254, minY: -12, maxY: 12 };
    expect(
      routes[1].points
        .slice(1)
        .some((p, i) => segmentHitsBox(routes[1].points[i], p, label)),
    ).toBe(false);
  });

  it("keeps the path orthogonal when a label node cannot be reached", () => {
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 60, height: 60 },
        { x: 400, y: 100, width: 60, height: 60 },
      ],
      edges: [
        {
          source: 0,
          target: 1,
          via: { x: 200, y: 300 },
          labelWidth: 80,
          labelHeight: 20,
        },
      ],
      groups: [
        {
          rect: { minX: 100, maxX: 300, minY: 200, maxY: 400 },
          members: new Set(),
        },
      ],
      clearance: 8,
    };
    const [{ points }] = routeOrthogonal(input);
    expect(points.length).toBeGreaterThan(2);
    for (let i = 1; i < points.length; i++) {
      expect(
        points[i].x === points[i - 1].x || points[i].y === points[i - 1].y,
      ).toBe(true);
    }
    expect(routeTouchesLabel({ points }, input.edges[0].via!, 80, 20)).toBe(
      false,
    );
    const [spot] = placeRouteLabels(input, [{ points }], "orthogonal");
    expect(spot!.blocked).toBeUndefined();
    expect(routeTouchesLabel({ points }, spot!, 80, 20)).toBe(true);
  });

  it("reroutes a detached label on a straight section without hiding bends", () => {
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 200, y: 0, width: 100, height: 60 },
      ],
      edges: [{ source: 0, target: 1, labelWidth: 140, labelHeight: 16 }],
      groups: [],
      clearance: 8,
    };
    const routes = [
      {
        points: [
          { x: 50, y: 0 },
          { x: 150, y: 0 },
        ],
      },
    ];
    const spots = [
      { x: 100, y: 100, anchorX: 100, anchorY: 0, detached: true },
    ];
    const [route] = bendOrthogonalToLabels(input, routes, spots);
    expect(routeTouchesLabel(route, spots[0], 140, 16)).toBe(true);
    expect(
      route.points
        .slice(1, -1)
        .every(
          (point) =>
            Math.abs(point.x - 100) >= 80 || Math.abs(point.y - 100) >= 16,
        ),
    ).toBe(true);
    for (let i = 1; i < route.points.length; i++) {
      expect(
        route.points[i].x === route.points[i - 1].x ||
          route.points[i].y === route.points[i - 1].y,
      ).toBe(true);
    }
  });

  it("keeps the original route when the label cannot be reached safely", () => {
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 200, y: 0, width: 100, height: 60 },
        { x: 100, y: 100, width: 200, height: 60 },
      ],
      edges: [{ source: 0, target: 1, labelWidth: 80, labelHeight: 16 }],
      groups: [],
      clearance: 8,
    };
    const routes = [
      {
        points: [
          { x: 50, y: 0 },
          { x: 150, y: 0 },
        ],
      },
    ];
    const spots = [
      { x: 100, y: 100, anchorX: 100, anchorY: 0, detached: true },
    ];
    expect(bendOrthogonalToLabels(input, routes, spots)).toEqual(routes);
  });

  it("rejects detached-label reroutes that turn within 10 pixels of the chip", () => {
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 200, y: 0, width: 100, height: 60 },
      ],
      edges: [{ source: 0, target: 1, labelWidth: 180, labelHeight: 16 }],
      groups: [],
      clearance: 8,
    };
    const routes = [
      {
        points: [
          { x: 50, y: 0 },
          { x: 150, y: 0 },
        ],
      },
    ];
    const spots = [
      { x: 100, y: 100, anchorX: 100, anchorY: 0, detached: true },
    ];
    expect(bendOrthogonalToLabels(input, routes, spots)).toEqual(routes);
  });

  it("does not add crossings to reach a detached label", () => {
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 200, y: 0, width: 100, height: 60 },
        { x: 100, y: 50, width: 10, height: 10 },
        { x: 100, y: 150, width: 10, height: 10 },
      ],
      edges: [
        { source: 0, target: 1, labelWidth: 140, labelHeight: 16 },
        { source: 2, target: 3 },
      ],
      groups: [],
      clearance: 8,
    };
    const routes = [
      {
        points: [
          { x: 50, y: 0 },
          { x: 150, y: 0 },
        ],
      },
      {
        points: [
          { x: 100, y: 55 },
          { x: 100, y: 145 },
        ],
      },
    ];
    const spots = [
      { x: 100, y: 100, anchorX: 100, anchorY: 0, detached: true },
      null,
    ];
    expect(bendOrthogonalToLabels(input, routes, spots)).toEqual(routes);
  });

  function expectCenteredEnd(
    end: { x: number; y: number },
    adjacent: { x: number; y: number },
    node: RouteInput["nodes"][number],
  ) {
    const horizontal =
      Math.abs(end.y - node.y) < 0.250001 &&
      Math.abs(adjacent.y - node.y) < 0.250001 &&
      Math.abs(Math.abs(end.x - node.x) - node.width / 2) < 1e-6;
    const vertical =
      Math.abs(end.x - node.x) < 0.250001 &&
      Math.abs(adjacent.x - node.x) < 0.250001 &&
      Math.abs(Math.abs(end.y - node.y) - node.height / 2) < 1e-6;
    expect(horizontal || vertical).toBe(true);
  }

  it.each([false, true])(
    "keeps subpixel-aligned connections straight (vertical: %s)",
    (vertical) => {
      const nodes = [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 400, y: 0.04, width: 100, height: 60 },
      ].map((node) => (vertical ? { ...node, x: node.y, y: node.x } : node));
      const [{ points }] = routeOrthogonal({
        nodes,
        edges: [{ source: 0, target: 1 }],
        groups: [],
        clearance: 8,
      });
      expect(points).toHaveLength(2);
      expect(vertical ? points[0].x : points[0].y).toBeCloseTo(0.02);
      expectCenteredEnd(points[0], points[1], nodes[0]);
      expectCenteredEnd(points[1], points[0], nodes[1]);
    },
  );

  it.each([
    { x: 300, y: 20, width: 140, height: 80 },
    { x: 20, y: 300, width: 140, height: 80 },
    { x: 300, y: 200, width: 140, height: 80 },
    { x: -300, y: -20, width: 140, height: 80 },
    { x: 0.25, y: 300, width: 140, height: 80 },
  ])("connects side midpoints for a target at ($x, $y)", (target) => {
    const source = { x: 0, y: 0, width: 100, height: 60 };
    const [route] = routeOrthogonal({
      nodes: [source, target],
      edges: [{ source: 0, target: 1 }],
      groups: [],
      clearance: 8,
    });
    const points = route.points;
    expectCenteredEnd(points[0], points[1], source);
    expectCenteredEnd(
      points[points.length - 1],
      points[points.length - 2],
      target,
    );
    for (let i = 1; i < points.length; i++) {
      expect(
        Math.abs(points[i].x - points[i - 1].x) < 1e-6 ||
          Math.abs(points[i].y - points[i - 1].y) < 1e-6,
      ).toBe(true);
    }
  });

  it("routes around a node using only horizontal and vertical segments", () => {
    const [route] = routeOrthogonal(blocked);
    expect(hitsMiddle(route.points)).toBe(false);
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1];
      const b = route.points[i];
      expect(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6).toBe(
        true,
      );
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(20);
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
    expectCenteredEnd(route.points[0], route.points[1], blocked.nodes[0]);
    expectCenteredEnd(
      route.points[route.points.length - 1],
      route.points[route.points.length - 2],
      blocked.nodes[2],
    );
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

  it("keeps shared endpoints centred while routing around obstacles", () => {
    const input: RouteInput = {
      ...blocked,
      nodes: [
        { ...blocked.nodes[0], x: 0.25 },
        blocked.nodes[1],
        { ...blocked.nodes[2], y: 0.25 },
        { x: 400, y: 160, width: 140, height: 80 },
      ],
      edges: [
        { source: 0, target: 2 },
        { source: 0, target: 3 },
        { source: 3, target: 2 },
      ],
    };
    const routes = routeOrthogonal(input);
    routes.forEach(({ points }, i) => {
      const { source, target } = input.edges[i];
      expectCenteredEnd(points[0], points[1], input.nodes[source]);
      expectCenteredEnd(
        points[points.length - 1],
        points[points.length - 2],
        input.nodes[target],
      );
      expect(hitsMiddle(points)).toBe(false);
    });
  });

  it("places a small vertical adjustment midway between nodes", () => {
    const [route] = routeOrthogonal({
      nodes: [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 400, y: 24, width: 100, height: 60 },
      ],
      edges: [{ source: 0, target: 1 }],
      groups: [],
      clearance: 8,
    });
    expect(route.points).toEqual([
      { x: 50, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 24 },
      { x: 350, y: 24 },
    ]);
  });

  it("leaves room for an arrowhead rather than bending just before it", () => {
    const [route] = routeOrthogonal({
      nodes: [
        { x: 0, y: 0, width: 100, height: 60 },
        { x: 400, y: 8, width: 100, height: 60 },
      ],
      edges: [{ source: 0, target: 1 }],
      groups: [],
      clearance: 8,
    });
    for (let i = 1; i < route.points.length; i++) {
      expect(
        Math.hypot(
          route.points[i].x - route.points[i - 1].x,
          route.points[i].y - route.points[i - 1].y,
        ),
      ).toBeGreaterThanOrEqual(20);
    }
  });

  it("simplifies a near-aligned detour without backtracking or short endpoint approaches", () => {
    const input: RouteInput = {
      nodes: [
        { x: 0, y: 15, width: 100, height: 90 },
        { x: 208, y: 0, width: 100, height: 100 },
      ],
      edges: [{ source: 0, target: 1 }],
      groups: [],
      clearance: 8,
    };
    const [route] = bendOrthogonalToLabels(
      input,
      [
        {
          points: [
            { x: 50, y: 15 },
            { x: 70, y: 15 },
            { x: 70, y: -20 },
            { x: 138, y: -20 },
            { x: 138, y: 0 },
            { x: 158, y: 0 },
          ],
        },
      ],
      [null],
    );
    expect(route.points).toEqual([
      { x: 50, y: 15 },
      { x: 104, y: 15 },
      { x: 104, y: 0 },
      { x: 158, y: 0 },
    ]);
  });

  it("keeps tight spaces orthogonal when full-length approaches cannot fit", () => {
    const nodes = [
      { x: 0, y: 0, width: 20, height: 20 },
      { x: 25, y: 8, width: 20, height: 20 },
    ];
    const [{ points }] = routeOrthogonal({
      nodes,
      edges: [{ source: 0, target: 1 }],
      groups: [],
      clearance: 2,
    });
    expectCenteredEnd(points[0], points[1], nodes[0]);
    expectCenteredEnd(
      points[points.length - 1],
      points[points.length - 2],
      nodes[1],
    );
    for (let i = 1; i < points.length; i++) {
      expect(
        points[i].x === points[i - 1].x || points[i].y === points[i - 1].y,
      ).toBe(true);
    }
  });

  it.each([false, true])(
    "separates parallel routes beyond shared attachment stubs (vertical: %s)",
    (vertical) => {
      const nodes = [
        { x: 0, y: 0, width: 60, height: 60 },
        { x: 400, y: 0, width: 60, height: 60 },
      ].map((node) => (vertical ? { ...node, x: node.y, y: node.x } : node));
      const routes = routeOrthogonal({
        nodes,
        edges: [
          { source: 0, target: 1 },
          { source: 0, target: 1 },
          { source: 1, target: 0 },
        ],
        groups: [],
        clearance: 8,
      });
      const runs = routes.map(({ points }) => {
        const oriented = points.map((p) => (vertical ? { x: p.y, y: p.x } : p));
        return oriented.slice(1).flatMap((b, i) => {
          const a = oriented[i];
          return a.y === b.y
            ? [
                {
                  min: Math.max(50, Math.min(a.x, b.x)),
                  max: Math.min(350, Math.max(a.x, b.x)),
                  lane: a.y,
                },
              ]
            : [];
        });
      });
      for (let i = 0; i < runs.length; i++) {
        for (let j = i + 1; j < runs.length; j++) {
          for (const a of runs[i]) {
            for (const b of runs[j]) {
              if (Math.min(a.max, b.max) > Math.max(a.min, b.min)) {
                expect(Math.abs(a.lane - b.lane)).toBeGreaterThanOrEqual(6);
              }
            }
          }
        }
      }
      routes.forEach(({ points }, i) => {
        const source = i === 2 ? 1 : 0;
        expectCenteredEnd(points[0], points[1], nodes[source]);
        expectCenteredEnd(
          points[points.length - 1],
          points[points.length - 2],
          nodes[1 - source],
        );
        for (let j = 1; j < points.length; j++) {
          expect(
            Math.hypot(
              points[j].x - points[j - 1].x,
              points[j].y - points[j - 1].y,
            ),
          ).toBeGreaterThanOrEqual(20);
        }
      });
    },
  );
});
