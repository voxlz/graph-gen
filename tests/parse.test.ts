import { parseGraphText } from "../src/parse";

describe("parseGraphText", () => {
  it("returns a parse error for malformed DSL", () => {
    const result = parseGraphText("nodes {\n  box customer\n");

    expect(result.errors).toEqual(["Unbalanced braces in DSL block"]);
  });

  it("loads a valid graph without parse errors", () => {
    const result = parseGraphText("nodes {\n  box customer\n}");

    expect(result.errors).toEqual([]);
    expect(result.spec.nodes).toEqual([
      expect.objectContaining({ id: "customer" }),
    ]);
  });
});
