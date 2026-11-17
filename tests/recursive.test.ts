import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundlePath, rendererCommand } from "../src/bundle";

const graph = `graph {
    outputPath "./generated/{file}"
}
nodes {
    box source: "Source"
    box target: "Target"
}
edges {
    source --> target
}
`;

function run(directory: string, ...args: string[]) {
  const renderer = rendererCommand();
  return spawnSync(renderer.command, [...renderer.args, ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 60000,
  });
}

describe("recursive rendering", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "graphgen-recursive-"));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(["-r", "--recursive"])(
    "renders nested .ggn files using their normal output paths with %s",
    (flag) => {
      const nested = path.join(directory, "renders", "nested folder");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(directory, "graph.ggn"), graph);
      fs.writeFileSync(path.join(nested, "graph.GGN"), graph);
      fs.writeFileSync(path.join(nested, "ignored.txt"), graph);
      fs.symlinkSync(directory, path.join(nested, "loop"), "dir");
      fs.writeFileSync(
        path.join(nested, "importer.ggn"),
        `import "../../graph.ggn"\n${graph}`,
      );

      const result = run(directory, flag, flag === "-r" ? "." : directory);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("[parse]");
      expect(result.stdout).toContain("rendered 3 of 3 .ggn file(s); 0 failed");
      for (const output of [
        path.join(directory, "generated", "graph.png"),
        path.join(nested, "generated", "graph.png"),
        path.join(nested, "generated", "importer.png"),
      ]) {
        expect(fs.existsSync(output)).toBe(true);
      }
      expect(fs.existsSync(path.join(nested, "generated", "ignored.png"))).toBe(
        false,
      );
    },
    60000,
  );

  it("reports an empty current directory when no path is supplied", () => {
    const result = run(directory, "-r");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no .ggn files found");
  });

  it("renders from a compiled-only installation without rebuilding", () => {
    rendererCommand();
    const installed = path.join(directory, "package");
    fs.mkdirSync(path.join(installed, "dist"), { recursive: true });
    const installedCli = path.join(installed, "dist", "index.js");
    fs.copyFileSync(bundlePath, installedCli);
    for (const file of ["package.json", "style.jsonc"]) {
      fs.copyFileSync(
        path.resolve(__dirname, "..", file),
        path.join(installed, file),
      );
    }
    fs.mkdirSync(path.join(installed, "node_modules"));
    fs.symlinkSync(
      path.dirname(require.resolve("canvas/package.json")),
      path.join(installed, "node_modules", "canvas"),
      "dir",
    );
    const graphs = path.join(directory, "graphs");
    fs.mkdirSync(graphs);
    fs.writeFileSync(path.join(graphs, "graph.ggn"), graph);

    const result = spawnSync(process.execPath, [installedCli, "-r", "."], {
      cwd: graphs,
      encoding: "utf8",
      timeout: 60000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("[bundle]");
    expect(result.stderr).not.toContain("[parse]");
    expect(result.stdout).toContain("rendered 1 of 1 .ggn file(s); 0 failed");
    expect(fs.existsSync(path.join(graphs, "generated", "graph.png"))).toBe(
      true,
    );
  }, 60000);

  it.each(["missing", "file.ggn"])(
    "reports an invalid directory %s with a nonzero exit status",
    (target) => {
      fs.writeFileSync(path.join(directory, "file.ggn"), graph);
      const result = run(directory, "-r", target);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("[recursive]");
      expect(result.stdout).not.toContain("Wrote");
    },
  );

  it("continues after a failed render and exits nonzero", () => {
    fs.writeFileSync(path.join(directory, "blocked"), "not a directory");
    fs.writeFileSync(
      path.join(directory, "a-bad.ggn"),
      'graph {\n    outputPath "./blocked/{file}"\n}\n',
    );
    fs.writeFileSync(path.join(directory, "z-good.ggn"), graph);

    const result = run(directory, "-r", ".");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed to render");
    expect(result.stderr).toContain("a-bad.ggn");
    expect(result.stdout).toContain("rendered 1 of 2 .ggn file(s); 1 failed");
    expect(fs.existsSync(path.join(directory, "generated", "z-good.png"))).toBe(
      true,
    );
  }, 60000);
});
