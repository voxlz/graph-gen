import type { GraphSpec } from "./parse";

export interface DiagnosticLocation {
  file?: string;
  line?: number;
}

export interface ValidationResult {
  errors: string[];
  locations: DiagnosticLocation[];
}

function findOrderingCycle(
  edges: Array<{ left: string; right: string }>,
): string[] | null {
  const adjacency = new Map<string, Set<string>>();
  for (const { left, right } of edges) {
    if (!adjacency.has(left)) adjacency.set(left, new Set());
    adjacency.get(left)?.add(right);
  }

  const state = new Map<string, number>();
  const parent = new Map<string, string>();
  const visit = (node: string): string[] | null => {
    state.set(node, 1);
    for (const next of adjacency.get(node) ?? []) {
      if (state.get(next) === 1) {
        const cycle = [node];
        let current = node;
        while (current !== next) {
          current = parent.get(current) as string;
          cycle.push(current);
        }
        return cycle.reverse();
      }
      if (!state.get(next)) {
        parent.set(next, node);
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    state.set(node, 2);
    return null;
  };

  for (const node of adjacency.keys()) {
    if (!state.get(node)) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function validateGraph(spec: GraphSpec): ValidationResult {
  const errors: string[] = [];
  const locations: DiagnosticLocation[] = [];
  const pushError = (message: string, source?: any) => {
    errors.push(message);
    locations.push({ file: source?.sourceFile, line: source?.line });
  };
  const nodeIds = new Set<string>();
  const boundaryIds = new Set<string>();

  for (const node of spec.nodes) {
    if (nodeIds.has(node.id)) pushError(`duplicate node id: ${node.id}`, node);
    nodeIds.add(node.id);
  }
  for (const boundary of spec.boundaries) {
    if (boundaryIds.has(boundary.id)) {
      pushError(`duplicate boundary id: ${boundary.id}`, boundary);
    }
    boundaryIds.add(boundary.id);
  }

  const knownIds = new Set([...nodeIds, ...boundaryIds]);
  const boundariesById = new Map(
    spec.boundaries.map((boundary) => [boundary.id, boundary]),
  );
  const membersFor = (id: string): string[] => {
    if (nodeIds.has(id)) return [id];
    if (!boundaryIds.has(id)) return [];
    return spec.nodes
      .filter((node) => {
        const seen = new Set<string>();
        let parent = node.parent;
        while (parent && !seen.has(parent)) {
          if (parent === id) return true;
          seen.add(parent);
          parent = boundariesById.get(parent)?.parent;
        }
        return false;
      })
      .map((node) => node.id);
  };
  for (const node of spec.nodes) {
    if (node.parent && !boundaryIds.has(node.parent)) {
      pushError(
        `node ${node.id} references missing boundary: ${node.parent}`,
        node,
      );
    }
  }
  for (const boundary of spec.boundaries) {
    if (boundary.parent && !boundaryIds.has(boundary.parent)) {
      pushError(
        `boundary ${boundary.id} references missing parent boundary: ${boundary.parent}`,
        boundary,
      );
    }
  }

  for (const edge of spec.edges) {
    if (!nodeIds.has(edge.source)) {
      pushError(`edge references missing source node: ${edge.source}`, edge);
    }
    if (!nodeIds.has(edge.target)) {
      pushError(`edge references missing target node: ${edge.target}`, edge);
    }
    if (edge.source === edge.target) {
      pushError(
        `edge from a node to itself is not supported: ${edge.source}`,
        edge,
      );
    }
  }

  const ordering = {
    x: [] as Array<{ left: string; right: string }>,
    y: [] as Array<{ left: string; right: string }>,
  };
  const addOrdering = (axis: "x" | "y", left: string, right: string) => {
    const leftMembers = membersFor(left);
    const rightMembers = membersFor(right);
    for (const leftMember of leftMembers) {
      for (const rightMember of rightMembers) {
        ordering[axis].push({ left: leftMember, right: rightMember });
      }
    }
  };
  const requireId = (id: string, context: string, source: any) => {
    if (!knownIds.has(id))
      pushError(
        `${context} references missing node or boundary: ${id}`,
        source,
      );
  };

  for (const constraint of spec.constraints) {
    if (constraint.type === "align") {
      if (constraint.axis !== "x" && constraint.axis !== "y") {
        pushError(
          `align constraint has invalid axis: ${constraint.axis}`,
          constraint,
        );
      }
      for (const id of constraint.ids ?? []) {
        requireId(id, "align constraint", constraint);
      }
      continue;
    }

    const left = constraint.a ?? constraint.left ?? constraint.top;
    const right = constraint.b ?? constraint.right ?? constraint.bottom;
    if (!left || !right) {
      pushError(
        `constraint is missing an endpoint: ${constraint.type}`,
        constraint,
      );
      continue;
    }
    requireId(left, `constraint ${constraint.type}`, constraint);
    requireId(right, `constraint ${constraint.type}`, constraint);
    switch (constraint.type) {
      case "left":
      case "top":
        addOrdering(constraint.type === "left" ? "x" : "y", left, right);
        break;
      case "right":
      case "bottom":
        addOrdering(constraint.type === "right" ? "x" : "y", right, left);
        break;
      case "topleft":
        addOrdering("x", left, right);
        addOrdering("y", left, right);
        break;
      case "topright":
        addOrdering("x", right, left);
        addOrdering("y", left, right);
        break;
      case "bottomleft":
        addOrdering("x", left, right);
        addOrdering("y", right, left);
        break;
      case "bottomright":
        addOrdering("x", right, left);
        addOrdering("y", right, left);
        break;
      case "near":
        break;
      default:
        pushError(
          `unsupported constraint type: ${constraint.type}`,
          constraint,
        );
    }
  }

  for (const axis of ["x", "y"] as const) {
    const cycle = findOrderingCycle(ordering[axis]);
    if (cycle) {
      const direction = axis === "x" ? "left/right" : "top/bottom";
      pushError(
        `impossible ${direction} ordering (cycle): ${cycle.join(" -> ")} -> ${cycle[0]}`,
      );
    }
  }

  return { errors, locations };
}
