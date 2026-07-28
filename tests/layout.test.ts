import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "canvas";
import {
  solveLayout,
  type LayoutEdge,
  type LayoutNode,
  type LayoutOptions,
} from "../src/layout";
import { parseGraphText } from "../src/parse";
import { prepareEdges } from "../src/render";
import { angularRelaxationScore } from "../src/strategies/angular-relaxation";

const options = {
  minGap: 30,
  nodeGap: 20,
  boundaryPad: 15,
  labelBand: 10,
  nestPad: 10,
  iterations: 200,
};
const measureContext = createCanvas(10, 10).getContext("2d");
measureContext.font = "14px sans-serif";

function textWidth(text: string): number {
  return measureContext.measureText(text).width;
}

function node(
  id: string,
  width: number,
  height: number,
  boundaryParent: string | null = null,
): LayoutNode {
  return { id, x: 0, y: 0, width, height, boundaryParent };
}

function bookstoreNode(item: {
  id: string;
  label: string;
  shape: string;
  parent: string | null;
}): LayoutNode {
  const minimumWidth =
    item.shape === "actor" || item.shape === "circle"
      ? 90
      : item.shape === "database"
        ? 100
        : 120;
  const minimumHeight =
    item.shape === "actor" || item.shape === "circle"
      ? 90
      : item.shape === "database"
        ? 100
        : 60;
  return node(
    item.id,
    Math.max(minimumWidth, Math.ceil(textWidth(item.label)) + 28),
    minimumHeight,
    item.parent,
  );
}

function solveGraphFixture(
  relativePath: string[],
  overrides: Partial<LayoutOptions>,
) {
  const parsed = parseGraphText(
    fs.readFileSync(path.join(__dirname, "..", ...relativePath), "utf8"),
  );
  expect(parsed.errors).toEqual([]);
  const nodes = parsed.spec.nodes.map(bookstoreNode);
  const indexById = new Map(nodes.map((item, index) => [item.id, index]));
  const edges = parsed.spec.edges.map((edge) => {
    const lines = edge.label?.split("\n") ?? [];
    return {
      source: indexById.get(edge.source) as number,
      target: indexById.get(edge.target) as number,
      label: edge.label,
      labelWidth: lines.length
        ? Math.max(...lines.map((line: string) => textWidth(line)))
        : 0,
      labelHeight: lines.length * 16,
    };
  });
  const result = solveLayout(
    nodes,
    parsed.spec.boundaries,
    edges,
    parsed.spec.constraints,
    { ...options, ...overrides },
  );
  return { nodes, indexById, result };
}

function rect(current: LayoutNode, padding = 0) {
  return {
    minX: current.x - current.width / 2 - padding,
    maxX: current.x + current.width / 2 + padding,
    minY: current.y - current.height / 2 - padding,
    maxY: current.y + current.height / 2 + padding,
  };
}

function rectanglesOverlap(
  a: ReturnType<typeof rect>,
  b: ReturnType<typeof rect>,
) {
  return (
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY
  );
}

function properSegmentsCross(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
) {
  const orient = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const a1 = orient(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const a2 = orient(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const b1 = orient(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const b2 = orient(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  return a1 * a2 < 0 && b1 * b2 < 0;
}

function pointToSegmentDistance(
  point: { x: number; y: number },
  segment: { x1: number; y1: number; x2: number; y2: number },
) {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared
    ? Math.max(
        0,
        Math.min(
          1,
          ((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) /
            lengthSquared,
        ),
      )
    : 0;
  return Math.hypot(
    point.x - (segment.x1 + projection * dx),
    point.y - (segment.y1 + projection * dy),
  );
}

describe("solveLayout", () => {
  it("compacts the aligned filesystem row toward the API", () => {
    const { nodes, indexById, result } = solveGraphFixture(
      ["demo", "showcase", "example.ggn"],
      {
        minGap: 100,
        nodeGap: 100,
        iterations: 1000,
        minimizeIterations: 100,
      },
    );

    expect(result.violations).toEqual([]);
    const api = nodes[indexById.get("api") as number];
    const db = nodes[indexById.get("db") as number];
    const cache = nodes[indexById.get("cache") as number];
    const filesystem = result.groups.get("container")!;
    expect(db.y).toBeCloseTo(cache.y, 8);
    expect(filesystem.minY - (api.y + api.height / 2)).toBeLessThan(300);
  });

  it("compacts aligned edge blocks to their required gap", () => {
    const { result } = solveGraphFixture(["demo", "showcase", "edges.ggn"], {
      minGap: 100,
      nodeGap: 20,
      iterations: 1000,
      minimizeIterations: 100,
    });

    expect(result.violations).toEqual([]);
    const block1 = result.groups.get("block1")!;
    const block2 = result.groups.get("block2")!;
    const gap = block2.minX - block1.maxX;
    expect(gap).toBeGreaterThanOrEqual(100 - 0.02);
    expect(gap).toBeLessThan(101);
  });

  it("aligns bookstore providers to reduce the external boundary", () => {
    const overrides = {
      minGap: 100,
      nodeGap: 100,
      iterations: 1000,
    };
    const baseline = solveGraphFixture(
      ["demo", "scopes", "bookstore_scope.ggn"],
      { ...overrides, minimizeIterations: 0 },
    );
    const minimized = solveGraphFixture(
      ["demo", "scopes", "bookstore_scope.ggn"],
      { ...overrides, minimizeIterations: 100 },
    );
    const boundaryArea = (result: typeof minimized.result) => {
      const rect = result.groups.get("external")!;
      return (rect.maxX - rect.minX) * (rect.maxY - rect.minY);
    };

    expect(minimized.result.violations).toEqual([]);
    expect(boundaryArea(minimized.result)).toBeLessThan(
      boundaryArea(baseline.result),
    );
  });

  it("keeps row and column constraints on matching coordinates", () => {
    const parsed = parseGraphText(`nodes {
  box a
  box b
  box c
  box d
}
constraints {
  align row a d
  align col b c
}`);
    expect(parsed.errors).toEqual([]);
    const nodes = parsed.spec.nodes.map(bookstoreNode);

    const result = solveLayout(
      nodes,
      parsed.spec.boundaries,
      [],
      parsed.spec.constraints,
      { ...options, minimizeIterations: 0 },
    );

    expect(result.violations).toEqual([]);
    const nodeById = new Map(nodes.map((current) => [current.id, current]));
    expect(nodeById.get("a")!.y).toBeCloseTo(nodeById.get("d")!.y, 8);
    expect(nodeById.get("b")!.x).toBeCloseTo(nodeById.get("c")!.x, 8);
  });

  it("packs aligned columns without cycling between adjacent overlaps", () => {
    const parsed = parseGraphText(`nodes {
  box idp
  box axisCom
  box crm
  box userApi
  box dsd
  box pia
  box mailServer
  box cdn
}
constraints {
  align col axisCom userApi dsd pia mailServer cdn
  align col idp crm
  align row idp axisCom
  align row crm userApi
  axisCom top dsd
  axisCom top userApi
  userApi top pia
  userApi top cdn
  userApi top dsd
}`);
    expect(parsed.errors).toEqual([]);
    const nodes = parsed.spec.nodes.map(bookstoreNode);

    const result = solveLayout(
      nodes,
      parsed.spec.boundaries,
      [],
      parsed.spec.constraints,
      {
        ...options,
        minGap: 100,
        nodeGap: 100,
        iterations: 1000,
        minimizeIterations: 0,
      },
    );

    expect(result.violations).toEqual([]);
    expect(result.iterations).toBeLessThan(1000);
  });

  it("minimizes disconnected nodes to their exact clearance", () => {
    const baselineNodes = [node("wide", 400, 60), node("small", 40, 60)];
    solveLayout(baselineNodes, [], [], [], {
      ...options,
      minimizeIterations: 0,
    });
    const baselineDistance = Math.abs(baselineNodes[0].x - baselineNodes[1].x);

    const minimizedNodes = [node("wide", 400, 60), node("small", 40, 60)];
    const result = solveLayout(minimizedNodes, [], [], [], {
      ...options,
      minimizeIterations: 100,
    });
    const minimizedDistance = Math.abs(
      minimizedNodes[0].x - minimizedNodes[1].x,
    );
    const exactClearance =
      minimizedNodes[0].width / 2 +
      minimizedNodes[1].width / 2 +
      options.nodeGap;

    expect(result.violations).toEqual([]);
    expect(minimizedDistance).toBeLessThan(baselineDistance);
    expect(minimizedDistance).toBeCloseTo(exactClearance, 1);
  });

  it("orders differently sized rectangular nodes without overlap", () => {
    const nodes = [node("wide", 180, 40), node("tall", 50, 160)];

    const result = solveLayout(
      nodes,
      [],
      [],
      [{ type: "left", a: "wide", b: "tall" }],
      options,
    );

    expect(result.valid).toBe(true);
    expect(rect(nodes[0]).maxX + options.minGap).toBeLessThanOrEqual(
      rect(nodes[1]).minX + 1,
    );
    expect(rectanglesOverlap(rect(nodes[0], 10), rect(nodes[1], 10))).toBe(
      false,
    );
  });

  it("applies a directional constraint to complete groups", () => {
    const nodes = [
      node("a1", 80, 40, "leftGroup"),
      node("a2", 120, 50, "leftGroup"),
      node("b1", 60, 90, "rightGroup"),
      node("b2", 100, 60, "rightGroup"),
    ];

    const result = solveLayout(
      nodes,
      [
        { id: "leftGroup", draw: false },
        { id: "rightGroup", draw: false },
      ],
      [],
      [{ type: "left", a: "leftGroup", b: "rightGroup" }],
      options,
    );

    expect(result.valid).toBe(true);
    const leftMax = Math.max(
      ...nodes.slice(0, 2).map((item) => rect(item).maxX),
    );
    const rightMin = Math.min(...nodes.slice(2).map((item) => rect(item).minX));
    expect(leftMax + options.minGap).toBeLessThanOrEqual(rightMin + 1);
  });

  it("removes straight-edge crossings without moving through nodes", () => {
    const nodes = [
      node("a", 40, 40),
      node("b", 40, 40),
      node("c", 40, 40),
      node("d", 40, 40),
    ];
    const edges = [
      { source: 0, target: 3 },
      { source: 1, target: 2 },
    ];

    const result = solveLayout(nodes, [], edges, [], options);

    expect(result.valid).toBe(true);
    const first = {
      x1: nodes[0].x,
      y1: nodes[0].y,
      x2: nodes[3].x,
      y2: nodes[3].y,
    };
    const second = {
      x1: nodes[1].x,
      y1: nodes[1].y,
      x2: nodes[2].x,
      y2: nodes[2].y,
    };
    expect(properSegmentsCross(first, second)).toBe(false);
    for (const [edgeIndex, edge] of edges.entries()) {
      const segment = edgeIndex === 0 ? first : second;
      const length = Math.hypot(
        segment.x2 - segment.x1,
        segment.y2 - segment.y1,
      );
      const normal = {
        x: -(segment.y2 - segment.y1) / length,
        y: (segment.x2 - segment.x1) / length,
      };
      for (const [nodeIndex, current] of nodes.entries()) {
        if (nodeIndex === edge.source || nodeIndex === edge.target) continue;
        const projectedHalfExtent =
          Math.abs(normal.x) * (current.width / 2) +
          Math.abs(normal.y) * (current.height / 2);
        expect(pointToSegmentDistance(current, segment)).toBeGreaterThanOrEqual(
          projectedHalfExtent + 8 - 0.02,
        );
      }
    }
  });

  it("places labels away from nodes and records snapshots at the requested cadence", () => {
    const nodes = [
      node("source", 100, 60),
      node("target", 100, 60),
      node("obstacle", 120, 80),
    ];
    const edges: LayoutEdge[] = [
      {
        source: 0,
        target: 1,
        label: "request payload",
        labelWidth: 105,
        labelHeight: 16,
      },
    ];

    const result = solveLayout(
      nodes,
      [],
      edges,
      [{ type: "left", a: "source", b: "target" }],
      { ...options, debugFrameEvery: 5 },
    );

    expect(result.violations).toEqual([]);
    expect(edges[0].labelX).toEqual(expect.any(Number));
    expect(edges[0].labelY).toEqual(expect.any(Number));
    const labelRect = {
      minX: (edges[0].labelX as number) - 105 / 2 - 4,
      maxX: (edges[0].labelX as number) + 105 / 2 + 4,
      minY: (edges[0].labelY as number) - 16 / 2 - 2,
      maxY: (edges[0].labelY as number) + 16 / 2 + 2,
    };
    expect(
      nodes.every((current) => !rectanglesOverlap(labelRect, rect(current))),
    ).toBe(true);
    expect(result.snapshots[0].iteration).toBe(0);
    expect(result.snapshots.at(-1)?.iteration).toBe(result.iterations);
    expect(
      result.snapshots
        .slice(1, -1)
        .every((snapshot) => snapshot.iteration % 5 === 0),
    ).toBe(true);
  });

  it("solves the nested bookstore demo topology", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "demo", "scopes", "bookstore_scope.ggn"),
      "utf8",
    );
    const parsed = parseGraphText(source);
    expect(parsed.errors).toEqual([]);
    const nodes = parsed.spec.nodes.map(bookstoreNode);
    const indexById = new Map(nodes.map((item, index) => [item.id, index]));
    const edges = parsed.spec.edges.map((edge) => ({
      source: indexById.get(edge.source) as number,
      target: indexById.get(edge.target) as number,
      label: edge.label,
      labelWidth: edge.label ? edge.label.length * 8 : 0,
      labelHeight: edge.label ? 16 : 0,
    }));

    const result = solveLayout(
      nodes,
      parsed.spec.boundaries,
      edges,
      parsed.spec.constraints,
      {
        ...options,
        minGap: 100,
        nodeGap: 100,
        iterations: 1000,
        minimizeIterations: 0,
      },
    );

    expect(result.violations).toEqual([]);
  });

  it("solves the ASRV scope topology without node-edge intersections", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "scopes", "asrv_scope.ggn"),
      "utf8",
    );
    const parsed = parseGraphText(source);
    expect(parsed.errors).toEqual([]);
    const nodes = parsed.spec.nodes.map(bookstoreNode);
    const indexById = new Map(nodes.map((item, index) => [item.id, index]));
    const edges = parsed.spec.edges.map((edge) => ({
      source: indexById.get(edge.source) as number,
      target: indexById.get(edge.target) as number,
      label: edge.label,
      labelWidth: edge.label ? textWidth(edge.label) : 0,
      labelHeight: edge.label ? 16 : 0,
    }));

    const result = solveLayout(
      nodes,
      parsed.spec.boundaries,
      edges,
      parsed.spec.constraints,
      {
        ...options,
        minGap: 100,
        nodeGap: 100,
        boundaryPad: 20,
        labelBand: 20,
        nestPad: 36,
        iterations: 1000,
        minimizeIterations: 100,
      },
    );

    expect(result.violations).toEqual([]);
    const vm = result.groups.get("vm")!;
    const internalNetwork = result.groups.get("internalNetwork")!;
    expect(internalNetwork.minX - vm.maxX).toBeGreaterThanOrEqual(100 - 0.02);
    const vmCenterY = (vm.minY + vm.maxY) / 2;
    const internalCenterY = (internalNetwork.minY + internalNetwork.maxY) / 2;
    expect(Math.abs(vmCenterY - internalCenterY)).toBeLessThan(150);
  });

  it("keeps the SRV client outside its nested network boundaries", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "scopes", "srv_scope.ggn"),
      "utf8",
    );
    const parsed = parseGraphText(source);
    expect(parsed.errors).toEqual([]);
    const nodes = parsed.spec.nodes.map(bookstoreNode);
    const indexById = new Map(nodes.map((item, index) => [item.id, index]));
    const edges = parsed.spec.edges.map((edge) => ({
      source: indexById.get(edge.source) as number,
      target: indexById.get(edge.target) as number,
      label: edge.label,
      labelWidth: edge.label ? textWidth(edge.label) : 0,
      labelHeight: edge.label ? 16 : 0,
    }));

    const result = solveLayout(
      nodes,
      parsed.spec.boundaries,
      edges,
      parsed.spec.constraints,
      {
        ...options,
        minGap: 100,
        nodeGap: 100,
        boundaryPad: 20,
        labelBand: 20,
        nestPad: 36,
        iterations: 1000,
        minimizeIterations: 0,
      },
    );

    expect(result.violations).toEqual([]);
  });

  it("relaxes shared-hub angles in the compass topology", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "demo", "showcase", "compass.ggn"),
      "utf8",
    );
    const parsed = parseGraphText(source);
    expect(parsed.errors).toEqual([]);
    const baselineNodes = parsed.spec.nodes.map(bookstoreNode);
    const baselineIndexById = new Map(
      baselineNodes.map((item, index) => [item.id, index]),
    );
    solveLayout(
      baselineNodes,
      parsed.spec.boundaries,
      parsed.spec.edges.map((edge) => ({
        source: baselineIndexById.get(edge.source) as number,
        target: baselineIndexById.get(edge.target) as number,
      })),
      parsed.spec.constraints,
      {
        ...options,
        minGap: 100,
        nodeGap: 100,
        boundaryPad: 20,
        labelBand: 20,
        nestPad: 36,
        iterations: 1000,
        minimizeIterations: 0,
      },
    );
    const nodes = parsed.spec.nodes.map(bookstoreNode);
    const indexById = new Map(nodes.map((item, index) => [item.id, index]));
    const edges = parsed.spec.edges.map((edge) => ({
      source: indexById.get(edge.source) as number,
      target: indexById.get(edge.target) as number,
    }));

    const result = solveLayout(
      nodes,
      parsed.spec.boundaries,
      edges,
      parsed.spec.constraints,
      {
        ...options,
        minGap: 100,
        nodeGap: 100,
        boundaryPad: 20,
        labelBand: 20,
        nestPad: 36,
        iterations: 1000,
        minimizeIterations: 100,
      },
    );

    expect(result.violations).toEqual([]);
    expect(
      angularRelaxationScore(
        parsed.spec.edges.map((edge) => ({
          source: nodes[indexById.get(edge.source) as number],
          target: nodes[indexById.get(edge.target) as number],
        })),
      ),
    ).toBeLessThan(0.8);
    const center = nodes[indexById.get("center") as number];
    const totalSpokeLength = ["n", "s", "e", "w", "ne", "nw", "se", "sw"]
      .map((id) => nodes[indexById.get(id) as number])
      .reduce(
        (sum, spoke) =>
          sum + Math.hypot(spoke.x - center.x, spoke.y - center.y),
        0,
      );
    expect(totalSpokeLength).toBeLessThan(2000);
    const footprintArea = (items: LayoutNode[]) => {
      const bounds = items
        .map((item) => rect(item))
        .reduce(
          (result, current) => ({
            minX: Math.min(result.minX, current.minX),
            maxX: Math.max(result.maxX, current.maxX),
            minY: Math.min(result.minY, current.minY),
            maxY: Math.max(result.maxY, current.maxY),
          }),
          { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
        );
      return (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
    };
    expect(footprintArea(nodes)).toBeLessThanOrEqual(
      footprintArea(baselineNodes),
    );
  });

  it("relaxes constrained overlap spokes along their free axes", () => {
    const { nodes, indexById, result } = solveGraphFixture(
      ["demo", "showcase", "overlap.ggn"],
      {
        minGap: 100,
        nodeGap: 100,
        boundaryPad: 20,
        labelBand: 20,
        nestPad: 36,
        iterations: 1000,
        minimizeIterations: 100,
      },
    );

    expect(result.violations).toEqual([]);
    const hub = nodes[indexById.get("hub") as number];
    const n1 = nodes[indexById.get("n1") as number];
    const n3 = nodes[indexById.get("n3") as number];
    // n1 is pinned to the right of the hub and n3 below it, so each keeps one
    // free axis. Minimization should spend that freedom levelling the spoke,
    // not leaving the node stranded diagonally.
    expect(n1.x).toBeGreaterThan(hub.x + 1);
    expect(Math.abs(n1.y - hub.y)).toBeLessThanOrEqual(n1.height);
    expect(n3.y).toBeGreaterThan(hub.y + 1);
    expect(n3.x).toBeLessThan(hub.x - 1);
  });

  it("compacts the disconnected bookstore UC2 cache inside Docker", () => {
    const scope = parseGraphText(
      fs.readFileSync(
        path.join(__dirname, "..", "demo", "scopes", "bookstore_scope.ggn"),
        "utf8",
      ),
    ).spec;
    const usecase = parseGraphText(
      fs.readFileSync(
        path.join(__dirname, "..", "demo", "usecases", "bookstore_uc2.ggn"),
        "utf8",
      ),
    ).spec;
    const solve = (minimizeIterations: number) => {
      const nodes = scope.nodes.map(bookstoreNode);
      const indexById = new Map(nodes.map((item, index) => [item.id, index]));
      const edges = prepareEdges(usecase.edges, "{index}. {label}").map(
        (edge) => {
          const lines = edge.label.split("\n");
          return {
            source: indexById.get(edge.source) as number,
            target: indexById.get(edge.target) as number,
            label: edge.label,
            labelWidth: Math.max(
              ...lines.map((line: string) => textWidth(line)),
            ),
            labelHeight: lines.length * 16,
          };
        },
      );
      const result = solveLayout(
        nodes,
        scope.boundaries,
        edges,
        scope.constraints,
        {
          ...options,
          minGap: 100,
          nodeGap: 100,
          boundaryPad: 20,
          labelBand: 20,
          nestPad: 36,
          iterations: 1000,
          minimizeIterations,
        },
      );
      return { nodes, indexById, result };
    };
    const baseline = solve(0);
    const minimized = solve(100);
    const area = (bounds: ReturnType<typeof rect>) =>
      (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
    const nodeById = (id: string) =>
      minimized.nodes[minimized.indexById.get(id)!];
    const cache = nodeById("cache");
    const stackTarget = [nodeById("gateway"), nodeById("orders")].sort(
      (first, second) =>
        Math.abs(cache.x - first.x) - Math.abs(cache.x - second.x),
    )[0];

    expect(minimized.result.violations).toEqual([]);
    expect(area(minimized.result.groups.get("docker")!)).toBeLessThan(
      area(baseline.result.groups.get("docker")!) * 0.7,
    );
    expect(area(minimized.result.groups.get("cloud")!)).toBeLessThan(
      area(baseline.result.groups.get("cloud")!),
    );
    expect(Math.abs(cache.x - stackTarget.x)).toBeLessThan(1);
    expect(rect(stackTarget).minY - rect(cache).maxY).toBeCloseTo(100, 1);
  });

  it("compacts disconnected weather UC1 nodes without enlarging the graph", () => {
    const scope = parseGraphText(
      fs.readFileSync(
        path.join(__dirname, "..", "demo", "scopes", "weather_scope.ggn"),
        "utf8",
      ),
    ).spec;
    const usecase = parseGraphText(
      fs.readFileSync(
        path.join(__dirname, "..", "demo", "usecases", "weather_uc1.ggn"),
        "utf8",
      ),
    ).spec;
    const solve = (minimizeIterations: number) => {
      const nodes = scope.nodes.map(bookstoreNode);
      const indexById = new Map(nodes.map((item, index) => [item.id, index]));
      const edges = prepareEdges(usecase.edges, "{index}. {label}").map(
        (edge) => {
          const lines = edge.label.split("\n");
          return {
            source: indexById.get(edge.source) as number,
            target: indexById.get(edge.target) as number,
            label: edge.label,
            labelWidth: Math.max(
              ...lines.map((line: string) => textWidth(line)),
            ),
            labelHeight: lines.length * 16,
          };
        },
      );
      const result = solveLayout(
        nodes,
        scope.boundaries,
        edges,
        scope.constraints,
        {
          ...options,
          minGap: 100,
          nodeGap: 150,
          boundaryPad: 20,
          labelBand: 20,
          nestPad: 36,
          iterations: 1000,
          minimizeIterations,
        },
      );
      return { nodes, indexById, result };
    };
    const baseline = solve(0);
    const minimized = solve(100);
    const nodeById = (solved: ReturnType<typeof solve>, id: string) =>
      solved.nodes[solved.indexById.get(id)!];
    const footprintArea = (solved: ReturnType<typeof solve>) => {
      const bounds = [
        ...solved.nodes.map((node) => rect(node)),
        solved.result.groups.get("vpc")!,
      ].reduce(
        (result, current) => ({
          minX: Math.min(result.minX, current.minX),
          maxX: Math.max(result.maxX, current.maxX),
          minY: Math.min(result.minY, current.minY),
          maxY: Math.max(result.maxY, current.maxY),
        }),
        { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
      );
      return (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
    };
    const baselineProviders = baseline.result.groups.get("providers")!;
    const minimizedProviders = minimized.result.groups.get("providers")!;
    const noaa = nodeById(minimized, "noaa");
    const satellite = nodeById(minimized, "satellite");
    const client = nodeById(minimized, "client");
    const attacker = nodeById(minimized, "attacker");

    expect(minimized.result.violations).toEqual([]);
    expect(footprintArea(minimized)).toBeLessThan(footprintArea(baseline));
    expect(minimizedProviders.maxX - minimizedProviders.minX).toBeLessThan(
      baselineProviders.maxX - baselineProviders.minX,
    );
    expect(rect(satellite).minY - rect(noaa).maxY).toBeCloseTo(150, 1);
    expect(rect(attacker).minX - rect(client).maxX).toBeCloseTo(150, 1);
    expect(rect(satellite).minX).toBeCloseTo(rect(noaa).minX, 1);
  });

  it("solves bookstore UC1 with merged multiline edge labels", () => {
    const scope = parseGraphText(
      fs.readFileSync(
        path.join(__dirname, "..", "demo", "scopes", "bookstore_scope.ggn"),
        "utf8",
      ),
    ).spec;
    const usecase = parseGraphText(
      fs.readFileSync(
        path.join(__dirname, "..", "demo", "usecases", "bookstore_uc1.ggn"),
        "utf8",
      ),
    ).spec;
    const nodes = scope.nodes.map(bookstoreNode);
    const indexById = new Map(nodes.map((item, index) => [item.id, index]));
    const edges = prepareEdges(usecase.edges, "{index}. {label}").map(
      (edge) => {
        const lines = edge.label.split("\n");
        return {
          source: indexById.get(edge.source) as number,
          target: indexById.get(edge.target) as number,
          label: edge.label,
          labelWidth: Math.max(...lines.map((line: string) => textWidth(line))),
          labelHeight: lines.length * 16,
        };
      },
    );

    const result = solveLayout(
      nodes,
      scope.boundaries,
      edges,
      scope.constraints,
      {
        ...options,
        minGap: 100,
        nodeGap: 150,
        boundaryPad: 20,
        labelBand: 20,
        nestPad: 36,
        iterations: 1000,
        minimizeIterations: 0,
      },
    );

    expect(result.violations).toEqual([]);
  });
});
