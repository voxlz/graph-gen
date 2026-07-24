import { parseGraphText } from "../src/parse";
import { validateGraph } from "../src/validate";

describe("validateGraph", () => {
  it("returns errors for missing references without discarding the graph", () => {
    const { spec, errors } = parseGraphText(`
      nodes {
        box customer
      }
      edges {
        customer --> missing
      }
      constraints {
        customer left missing
      }
    `);

    expect(errors).toEqual([]);
    expect(validateGraph(spec).errors).toEqual(
      expect.arrayContaining([
        "edge references missing target node: missing",
        "constraint left references missing node or boundary: missing",
      ]),
    );
    expect(spec.edges).toHaveLength(1);
  });

  it("returns errors for impossible ordering cycles", () => {
    const { spec, errors } = parseGraphText(`
      nodes {
        box alpha
        box beta
        box gamma
      }
      constraints {
        alpha left beta
        beta left gamma
        gamma left alpha
      }
    `);

    expect(errors).toEqual([]);
    expect(validateGraph(spec).errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("impossible left/right ordering (cycle)"),
      ]),
    );
  });

  it("rejects removed above and below constraint aliases", () => {
    const { spec, errors } = parseGraphText(`
      nodes {
        box alpha
        box beta
      }
      constraints {
        alpha above beta
        beta below alpha
      }
    `);

    expect(errors).toEqual([]);
    expect(validateGraph(spec).errors).toEqual(
      expect.arrayContaining([
        "unsupported constraint type: above",
        "unsupported constraint type: below",
      ]),
    );
  });
});
