import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyGraphSpec } from "../src/parse";
import {
  formatEdgeLabel,
  prepareEdges,
  renderErrorGraph,
  renderGraph,
} from "../src/render";

describe("renderGraph", () => {
  it("writes a PNG for an empty graph", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graphgen-render-"),
    );
    const output = path.join(directory, "graph.png");

    try {
      const result = await renderGraph(emptyGraphSpec(), output);

      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      expect(fs.statSync(output).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders a graph with the force layout strategy", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graphgen-render-force-"),
    );
    const output = path.join(directory, "graph.png");
    const spec = emptyGraphSpec();
    spec.graph.layout = "force";
    spec.nodes = [
      { id: "source", label: "Source", shape: "box", parent: null },
      { id: "target", label: "Target", shape: "box", parent: null },
      { id: "blocker", label: "Blocker", shape: "box", parent: null },
    ];
    spec.edges = [{ source: "source", target: "target" }];

    try {
      const result = await renderGraph(spec, output);

      expect(result.width).toBeGreaterThan(0);
      expect(fs.statSync(output).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("formats graph edge labels with their index and parsed edge data", () => {
    const edge = {
      source: "customer",
      target: "api",
      label: "GET /orders",
      arrowSource: false,
      arrowTarget: true,
      lineStyle: "solid",
      line: 12,
    };

    expect(
      formatEdgeLabel(
        "{index}. {source} -> {target}: {label} ({lineStyle}, line {line})",
        edge,
        1,
      ),
    ).toBe("2. customer -> api: GET /orders (solid, line 12)");
    expect(formatEdgeLabel("", edge, 1)).toBe("GET /orders");
  });

  it("formats duplicate edge labels before merging them", () => {
    expect(
      prepareEdges(
        [
          {
            source: "customer",
            target: "gateway",
            label: "Request",
            arrowTarget: true,
          },
          {
            source: "gateway",
            target: "customer",
            label: "Response",
            arrowTarget: true,
          },
        ],
        "{index}. {label}",
      ),
    ).toEqual([
      expect.objectContaining({
        source: "customer",
        target: "gateway",
        arrowSource: true,
        arrowTarget: true,
        label: "1. Request\n2. Response",
      }),
    ]);
  });

  it("writes an error PNG with the supplied diagnostics", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graphgen-render-"),
    );
    const output = path.join(directory, "error.png");

    try {
      const result = await renderErrorGraph(
        ["[parse] Unbalanced braces in DSL block"],
        output,
      );

      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      expect(fs.statSync(output).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves each diagnostic context line in the PNG", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graphgen-render-"),
    );
    const output = path.join(directory, "context.png");

    try {
      const result = await renderErrorGraph(
        [
          "[validate] graph.ggn:5\nERROR: invalid edge\nContext:\n     3 | }\n>    5 |     customer --> missing\n     6 | }",
        ],
        output,
      );

      expect(result.height).toBe(276);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
