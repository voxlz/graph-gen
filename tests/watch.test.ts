import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findDependentGraphFiles,
  findGraphFiles,
  outputPathFor,
} from "../src/watch";

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

  it("uses configured output paths when no override is supplied", () => {
    expect(
      outputPathFor(path.resolve("demo/showcase/edges.ggn")),
    ).toBeUndefined();
  });

  it("mirrors project-relative graph paths under an output override", () => {
    expect(
      outputPathFor(
        path.resolve("demo/showcase/edges.ggn"),
        path.resolve("renders"),
      ),
    ).toBe(path.resolve("renders/demo/showcase/edges.png"));
  });

  it("finds direct and transitive graph importers", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "graphgen-watch-"));
    const base = path.join(directory, "base.ggn");
    const middle = path.join(directory, "middle.ggn");
    const top = path.join(directory, "top.ggn");
    const unrelated = path.join(directory, "unrelated.ggn");
    fs.writeFileSync(base, "nodes {}\n");
    fs.writeFileSync(middle, 'import "./base.ggn"\n');
    fs.writeFileSync(top, 'import "./middle.ggn"\n');
    fs.writeFileSync(unrelated, "nodes {}\n");

    try {
      expect(
        findDependentGraphFiles(base, [base, middle, top, unrelated]),
      ).toEqual([middle, top]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
