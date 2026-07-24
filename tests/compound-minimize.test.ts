import { minimizeCompoundLayout } from "../src/compound-minimize";
import type { LayoutNode } from "../src/constraint-layout";

function node(
  id: string,
  x: number,
  boundaryParent: string | null = null,
): LayoutNode {
  return {
    id,
    x,
    y: 0,
    width: 40,
    height: 40,
    boundaryParent,
  };
}

function rect(current: LayoutNode) {
  return {
    minX: current.x - current.width / 2,
    maxX: current.x + current.width / 2,
    minY: current.y - current.height / 2,
    maxY: current.y + current.height / 2,
  };
}

function overlaps(
  first: ReturnType<typeof rect>,
  second: ReturnType<typeof rect>,
): boolean {
  return (
    first.minX < second.maxX &&
    first.maxX > second.minX &&
    first.minY < second.maxY &&
    first.maxY > second.minY
  );
}

describe("minimizeCompoundLayout", () => {
  it("shortens an edge through valid fractional endpoint moves", () => {
    const source = node("source", 0);
    const target = node("target", 1000);
    const nodes = [source, target];
    const measure = () => {
      const edgeLength = Math.hypot(target.x - source.x, target.y - source.y);
      return edgeLength < 60 ? null : { rects: nodes.map(rect), edgeLength };
    };

    minimizeCompoundLayout({
      nodes,
      edges: [{ source, target }],
      nodeGap: 20,
      generations: 100,
      obstacles: () =>
        nodes.map((current) => ({
          id: current.id,
          kind: "node" as const,
          rect: rect(current),
          node: current,
        })),
      measure,
      relax: () => undefined,
    });

    expect(measure()).not.toBeNull();
    expect(Math.hypot(target.x - source.x, target.y - source.y)).toBeLessThan(
      200,
    );
  });

  it("swaps same-container nodes when only the atomic swap shortens edges", () => {
    const first = node("first", 0, "items");
    const second = node("second", 800, "items");
    const leftAnchor = node("left-anchor", -400, "anchors");
    const rightAnchor = node("right-anchor", 1200, "anchors");
    const nodes = [first, second, leftAnchor, rightAnchor];
    const edges = [
      { source: first, target: rightAnchor },
      { source: second, target: leftAnchor },
    ];
    const measure = () => {
      const original = first.x === 0 && second.x === 800;
      const swapped = first.x === 800 && second.x === 0;
      const anchorsUnchanged = leftAnchor.x === -400 && rightAnchor.x === 1200;
      if ((!original && !swapped) || !anchorsUnchanged) return null;
      return {
        rects: nodes.map(rect),
        edgeLength: edges.reduce(
          (total, edge) => total + Math.abs(edge.target.x - edge.source.x),
          0,
        ),
      };
    };

    minimizeCompoundLayout({
      nodes,
      edges,
      nodeGap: 20,
      generations: 100,
      obstacles: () => [],
      measure,
      relax: () => undefined,
    });

    expect(first.x).toBe(800);
    expect(second.x).toBe(0);
    expect(measure()?.edgeLength).toBe(800);
  });

  it("does not swap nodes from different containers", () => {
    const first = node("first", 0, "left-container");
    const second = node("second", 800, "right-container");
    const leftAnchor = node("left-anchor", -400, "anchors");
    const rightAnchor = node("right-anchor", 1200, "anchors");
    const nodes = [first, second, leftAnchor, rightAnchor];
    const edges = [
      { source: first, target: rightAnchor },
      { source: second, target: leftAnchor },
    ];
    const measure = () => {
      const original = first.x === 0 && second.x === 800;
      const swapped = first.x === 800 && second.x === 0;
      const anchorsUnchanged = leftAnchor.x === -400 && rightAnchor.x === 1200;
      if ((!original && !swapped) || !anchorsUnchanged) return null;
      return {
        rects: nodes.map(rect),
        edgeLength: edges.reduce(
          (total, edge) => total + Math.abs(edge.target.x - edge.source.x),
          0,
        ),
      };
    };

    minimizeCompoundLayout({
      nodes,
      edges,
      nodeGap: 20,
      generations: 100,
      obstacles: () => [],
      measure,
      relax: () => undefined,
    });

    expect(first.x).toBe(0);
    expect(second.x).toBe(800);
    expect(measure()?.edgeLength).toBe(2400);
  });

  it("relocates an edge-free perimeter node to reduce rendered area", () => {
    const customer = node("customer", 0);
    customer.y = -130;
    const attacker = node("attacker", 230);
    const anchor = node("anchor", 0, "cloud");
    const nodes = [customer, attacker, anchor];
    const cloud = { minX: -100, maxX: 100, minY: -100, maxY: 100 };
    const padded = (current: LayoutNode, padding: number) => {
      const bounds = rect(current);
      return {
        minX: bounds.minX - padding,
        maxX: bounds.maxX + padding,
        minY: bounds.minY - padding,
        maxY: bounds.maxY + padding,
      };
    };
    const measure = () => {
      if (customer.x !== 0 || customer.y !== -130 || anchor.x !== 0) {
        return null;
      }
      if (
        overlaps(padded(attacker, 10), cloud) ||
        overlaps(padded(attacker, 10), padded(customer, 10))
      ) {
        return null;
      }
      return {
        rects: [...nodes.map(rect), cloud],
        edgeLength: Math.hypot(customer.x - anchor.x, customer.y - anchor.y),
      };
    };

    minimizeCompoundLayout({
      nodes,
      edges: [{ source: customer, target: anchor }],
      nodeGap: 20,
      generations: 100,
      obstacles: () => [
        {
          id: "cloud",
          kind: "boundary" as const,
          rect: cloud,
        },
      ],
      measure,
      relax: () => undefined,
    });

    expect(Math.abs(attacker.x)).toBe(60);
    expect(attacker.y).toBe(-130);
    expect(measure()).not.toBeNull();
  });
});
