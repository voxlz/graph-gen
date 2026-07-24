import path from "node:path";
import { resolveOutputPath } from "../src/output";

describe("resolveOutputPath", () => {
  const input = path.resolve("demo/usecases/bookstore_uc1.ggn");

  it("uses the graph-derived path as the default", () => {
    expect(resolveOutputPath(input, undefined, undefined)).toBe(
      path.resolve("demo/graphs/bookstore_uc1.png"),
    );
  });

  it("expands configured file placeholders relative to the input graph", () => {
    expect(resolveOutputPath(input, undefined, "../graphs/{file}")).toBe(
      path.resolve("demo/graphs/bookstore_uc1.png"),
    );
  });

  it("prefers an explicit CLI output path", () => {
    expect(resolveOutputPath(input, "custom.png", "../graphs/{file}")).toBe(
      "custom.png",
    );
  });
});
