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

  it("silently merges duplicate edges", () => {
    const result = parseGraphText(`edges {
customer --> gateway: "Request"
gateway --> customer: "Response"
}`);

    expect(result.errors).toEqual([]);
    expect(result.spec.warnings).toEqual([]);
    expect(result.spec.edges).toEqual([
      expect.objectContaining({
        source: "customer",
        target: "gateway",
        arrowSource: true,
        arrowTarget: true,
        label: "Request\nResponse",
      }),
    ]);
  });
});
