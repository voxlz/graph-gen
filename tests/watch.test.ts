import childProcess, { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import * as bundle from "../src/bundle";
import {
  findDependentGraphFiles,
  findGraphFiles,
  outputPathFor,
  startWatch,
} from "../src/watch";

describe("watch", () => {
  it("finds .ggn files recursively and ignores other extensions", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-gen-watch-"),
    );
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
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-gen-watch-"),
    );
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

  describe("render scheduling", () => {
    let directory: string;
    let watcher: fs.FSWatcher;
    let change: (filename: string) => void;
    let children: ChildProcess[];
    let rendered: string[];
    let originalSigintListeners: ReturnType<typeof process.listeners>;
    const parallelism = Math.max(
      1,
      Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1),
    );

    beforeEach(() => {
      jest.useFakeTimers();
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "graph-gen-watch-"));
      watcher = fs.watch(directory, () => {});
      jest.spyOn(fs, "watch").mockImplementation((...args: unknown[]) => {
        const listener = args[2];
        if (typeof listener !== "function") {
          throw new Error("Missing watch callback");
        }
        change = (filename) => listener("change", filename);
        return watcher;
      });
      jest.spyOn(console, "log").mockImplementation(() => {});
      jest.spyOn(bundle, "rendererCommand").mockReturnValue({
        command: "renderer",
        args: [],
      });
      children = [];
      rendered = [];
      jest.spyOn(childProcess, "spawn").mockImplementation((_command, args) => {
        const child = new ChildProcess();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        children.push(child);
        rendered.push(path.basename(args?.[0] ?? ""));
        return child;
      });
      originalSigintListeners = process.listeners("SIGINT");
      startWatch(directory);
    });

    afterEach(() => {
      watcher.close();
      for (const listener of process.listeners("SIGINT")) {
        if (!originalSigintListeners.includes(listener)) {
          process.removeListener("SIGINT", listener);
        }
      }
      jest.clearAllTimers();
      jest.useRealTimers();
      jest.restoreAllMocks();
      fs.rmSync(directory, { recursive: true, force: true });
    });

    function graph(name: string, contents = "nodes {}\n") {
      fs.writeFileSync(path.join(directory, name), contents);
    }

    async function finish(index: number) {
      children[index].emit("close", 0);
      await Promise.resolve();
    }

    function queueDependents() {
      graph("scope.ggn");
      for (let index = 0; index < parallelism + 2; index++) {
        graph(`a${index}.ggn`, 'import "./scope.ggn"\n');
      }
      change("scope.ggn");
      jest.advanceTimersByTime(300);
      expect(rendered[0]).toBe("scope.ggn");
      expect(children).toHaveLength(parallelism);
    }

    it("renders a saved graph before queued importers, then drains the queue", async () => {
      queueDependents();
      graph("z-saved.ggn");
      change("z-saved.ggn");
      jest.advanceTimersByTime(150);
      expect(children).toHaveLength(parallelism);

      await finish(0);
      expect(rendered[parallelism]).toBe("z-saved.ggn");

      for (let index = 1; index < children.length; index++) {
        await finish(index);
      }
      expect(rendered).toHaveLength(parallelism + 4);
      expect(new Set(rendered).size).toBe(rendered.length);
    });

    it("promotes a queued importer when it is saved directly", async () => {
      queueDependents();
      const saved = `a${parallelism + 1}.ggn`;
      change(saved);
      jest.advanceTimersByTime(150);

      await finish(0);
      expect(rendered[parallelism]).toBe(saved);
    });

    it("preserves save priority when a dependency resets its debounce timer", async () => {
      queueDependents();
      const saved = `a${parallelism + 1}.ggn`;
      change("scope.ggn");
      jest.advanceTimersByTime(75);
      change(saved);
      jest.advanceTimersByTime(225);

      await finish(0);
      expect(rendered[parallelism]).toBe(saved);
    });

    it("rerenders a file saved during its active render before queued importers", async () => {
      queueDependents();
      change("scope.ggn");
      jest.advanceTimersByTime(300);
      expect(rendered.filter((file) => file === "scope.ggn")).toHaveLength(1);

      await finish(0);
      expect(rendered[parallelism]).toBe("scope.ggn");
    });
  });
});
