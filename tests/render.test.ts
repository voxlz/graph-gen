import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyGraphSpec } from "../src/parse";
import { renderErrorGraph, renderGraph } from "../src/render";

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
