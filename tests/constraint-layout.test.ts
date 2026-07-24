import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "canvas";
import {
  solveConstraintLayout,
  type LayoutEdge,
  type LayoutNode,
} from "../src/constraint-layout";
import { parseGraphText } from "../src/parse";
import { prepareEdges } from "../src/render";

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

describe("solveConstraintLayout", () => {
  it("orders differently sized rectangular nodes without overlap", () => {
    const nodes = [node("wide", 180, 40), node("tall", 50, 160)];

    const result = solveConstraintLayout(
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

    const result = solveConstraintLayout(
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

    const result = solveConstraintLayout(nodes, [], edges, [], options);

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

    const result = solveConstraintLayout(
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

    const result = solveConstraintLayout(
      nodes,
      parsed.spec.boundaries,
      edges,
      parsed.spec.constraints,
      { ...options, minGap: 100, nodeGap: 100, iterations: 1000 },
    );

    expect(result.violations).toEqual([]);
  });

  it("solves bookstore UC2 with merged multiline edge labels", () => {
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

    const result = solveConstraintLayout(
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
      },
    );

    expect(result.violations).toEqual([]);
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

    const result = solveConstraintLayout(
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
      },
    );

    expect(result.violations).toEqual([]);
  });
});
