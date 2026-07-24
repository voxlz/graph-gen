import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyGraphSpec } from "../src/parse";
import { renderGraph } from "../src/render";

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
});
