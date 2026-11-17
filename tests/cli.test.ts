import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildBundle, bundlePath } from "../src/bundle";
import {
  handleInfoFlags,
  helpText,
  isRecursiveFlag,
  isWatchFlag,
  packageVersion,
} from "../src/cli";

describe("handleInfoFlags", () => {
  it.each(["--help", "-h"])("prints help for %s", (flag) => {
    expect(handleInfoFlags([flag], "1.2.3")).toEqual({
      output: helpText("1.2.3"),
      exitCode: 0,
      stream: "stdout",
    });
  });

  it.each(["--version", "-v"])("prints the version for %s", (flag) => {
    expect(handleInfoFlags([flag], "1.2.3")).toEqual({
      output: "1.2.3\n",
      exitCode: 0,
      stream: "stdout",
    });
  });

  it("rejects unknown options instead of treating them as an input file", () => {
    const result = handleInfoFlags(["--layout", "x.ggn"], "1.2.3");
    expect(result?.exitCode).toBe(2);
    expect(result?.stream).toBe("stderr");
    expect(result?.output).toContain("unknown option --layout");
  });

  it("leaves normal render arguments alone", () => {
    expect(handleInfoFlags(["graph.ggn", "out.png"], "1.2.3")).toBeNull();
    expect(handleInfoFlags([], "1.2.3")).toBeNull();
  });

  it.each(["--watch", "-w"])("accepts %s as watch mode", (flag) => {
    expect(isWatchFlag(flag)).toBe(true);
    expect(handleInfoFlags([flag, "graphs"], "1.2.3")).toBeNull();
  });

  it.each(["--recursive", "-r"])("accepts %s as recursive mode", (flag) => {
    expect(isRecursiveFlag(flag)).toBe(true);
    expect(handleInfoFlags([flag, "."], "1.2.3")).toBeNull();
    expect(handleInfoFlags([flag], "1.2.3")).toBeNull();
  });

  it.each([
    ["-r", ".", "out"],
    ["--recursive", "--unknown"],
  ])("rejects invalid recursive arguments %j", (...args) => {
    expect(handleInfoFlags(args, "1.2.3")).toEqual({
      output: expect.stringContaining("expected --recursive [path]"),
      exitCode: 2,
      stream: "stderr",
    });
  });

  it("reads the version from package.json", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    );
    expect(packageVersion()).toBe(pkg.version);
  });

  it("uses the renamed command and documents legacy environment aliases", () => {
    const help = helpText("1.2.3");
    expect(help).toContain("graph-gen --help");
    expect(help).toContain("GRAPH_GEN_LAYOUT");
    expect(help).toContain("GRAPHGEN_*");
  });

  it("builds an executable CLI that survives rebuilding", () => {
    buildBundle();
    expect(fs.statSync(bundlePath).mode & 0o111).not.toBe(0);
    expect(execFileSync(bundlePath, ["--version"], { encoding: "utf8" })).toBe(
      `${packageVersion()}\n`,
    );
  });

  it("packages the built CLI and its runtime files", () => {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
    });
    const result: Array<{ files: Array<{ path: string }> }> = JSON.parse(
      output.slice(output.indexOf("[\n")),
    );
    const files = result[0].files.map((file) => file.path);
    expect(files).toEqual(
      expect.arrayContaining(["dist/index.js", "style.jsonc"]),
    );
    expect(files).not.toContain("src/index.ts");
  }, 30000);
});
