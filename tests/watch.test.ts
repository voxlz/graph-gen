import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findGraphFiles, outputPathFor } from "../src/watch";

describe("watch", () => {
  it("finds .ggn files recursively and ignores other extensions", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graphgen-watch-"));
    const nested = path.join(directory, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(directory, "graph.ggn"), "graph {}");
    fs.writeFileSync(path.join(nested, "child.ggn"), "graph {}");
    fs.writeFileSync(path.join(nested, "legacy.txt"), "graph {}");

    try {
      expect(findGraphFiles(directory)).toEqual([
        path.join(directory, "graph.ggn"),
        path.join(nested, "child.ggn"),
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("mirrors project-relative graph paths under renders", () => {
    expect(outputPathFor(path.resolve("demo/showcase/edges.ggn"))).toBe(
      path.resolve("renders/demo/showcase/edges.png"),
    );
  });
});
