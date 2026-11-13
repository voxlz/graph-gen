import fs from "node:fs";
import path from "node:path";
import {
  handleInfoFlags,
  helpText,
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

  it("reads the version from package.json", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    );
    expect(packageVersion()).toBe(pkg.version);
  });
});
