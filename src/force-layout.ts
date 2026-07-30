import type {
  LayoutBoundary,
  LayoutEdge,
  LayoutNode,
  LayoutSnapshot,
} from "./layout";

const MINIMUM_ANGULAR_GAP = (40 * Math.PI) / 180;

export interface ForceLayoutOptions {
  iterations: number;
  nodeGap: number;
  linkLength: number;
  nodeRepulsion: number;
  boundaryRepulsion: number;
  edgeAttraction: number;
  siblingAttraction: number;
  crossingRepulsion: number;
  angularSeparation: number;
  edgePressure: number;
  step: number;
  minimumStep: number;
  damping: number;
  convergenceThreshold: number;
  stableIterations: number;
  collisionRampIterations: number;
  debugFrameEvery?: number;
}

export const DEFAULT_FORCE_LAYOUT: Omit<
  ForceLayoutOptions,
  "iterations" | "nodeGap" | "linkLength"
> = {
  nodeRepulsion: 1.4,
  boundaryRepulsion: 0.7,
  edgeAttraction: 0.08,
  siblingAttraction: 0.018,
  crossingRepulsion: 0.45,
  angularSeparation: 0.7,
  edgePressure: 0,
  step: 18,
  minimumStep: 0.01,
  damping: 0.7,
  convergenceThreshold: 0.01,
  stableIterations: 5,
  collisionRampIterations: 250,
};

interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Entity {
  id: string;
  parent: string | null;
  nodes: LayoutNode[];
  rect: Rect;
}

function rectFor(nodes: LayoutNode[]): Rect {
  return nodes.reduce<Rect>(
    (rect, node) => ({
      minX: Math.min(rect.minX, node.x - node.width / 2),
      minY: Math.min(rect.minY, node.y - node.height / 2),
      maxX: Math.max(rect.maxX, node.x + node.width / 2),
      maxY: Math.max(rect.maxY, node.y + node.height / 2),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

function center(rect: Rect) {
  return { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 };
}

function segmentsCross(
  a: LayoutNode,
  b: LayoutNode,
  c: LayoutNode,
  d: LayoutNode,
): boolean {
  const orient = (p: LayoutNode, q: LayoutNode, r: LayoutNode) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = orient(a, b, c);
  const abD = orient(a, b, d);
  const cdA = orient(c, d, a);
  const cdB = orient(c, d, b);
  return (
    ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
    ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
  );
}

function membersOf(
  boundaryId: string,
  nodes: LayoutNode[],
  boundaryById: Map<string, LayoutBoundary>,
): LayoutNode[] {
  return nodes.filter((node) => {
    let parent = node.boundaryParent;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      if (parent === boundaryId) return true;
      seen.add(parent);
      parent = boundaryById.get(parent)?.parent ?? null;
    }
    return false;
  });
}

function seedGrid(nodes: LayoutNode[], gap: number): void {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const cell =
    Math.max(...nodes.map((node) => Math.max(node.width, node.height))) + gap;
  for (const [index, node] of [...nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .entries()) {
    node.x = (index % columns) * cell;
    node.y = Math.floor(index / columns) * cell;
  }
}

export function applyForceLayout(
  nodes: LayoutNode[],
  boundaries: LayoutBoundary[],
  edges: LayoutEdge[],
  options: ForceLayoutOptions,
): LayoutSnapshot[] {
  if (nodes.length < 2) return [];
  seedGrid(nodes, options.nodeGap);
  const boundaryById = new Map(
    boundaries.map((boundary) => [boundary.id, boundary]),
  );
  const endpoint = (edge: LayoutEdge, side: "source" | "target") => {
    const value = edge[side];
    return typeof value === "number" ? nodes[value] : value;
  };
  const connectedNodes = new Set(
    edges.flatMap((edge) => [
      endpoint(edge, "source"),
      endpoint(edge, "target"),
    ]),
  );
  const velocities = new Map(nodes.map((node) => [node, { x: 0, y: 0 }]));
  const snapshots: LayoutSnapshot[] = [];
  const every = Math.max(0, Math.floor(options.debugFrameEvery ?? 0));
  const captureSnapshot = (iteration: number): LayoutSnapshot => ({
    iteration,
    phase: "force",
    violations: 0,
    nodes: nodes.map(({ id, x, y, width, height }) => ({
      id,
      x,
      y,
      width,
      height,
    })),
    groups: boundaries.map((boundary) => {
      const members = membersOf(boundary.id, nodes, boundaryById);
      return {
        id: boundary.id,
        rect: members.length ? rectFor(members) : null,
      };
    }),
    labels: [],
  });
  if (every > 0) snapshots.push(captureSnapshot(0));
  let stable = 0;
  let completedIterations = 0;

  for (let iteration = 0; iteration < options.iterations; iteration++) {
    const forces = new Map(nodes.map((node) => [node, { x: 0, y: 0 }]));
    const addForce = (members: LayoutNode[], x: number, y: number) => {
      for (const member of members) {
        const force = forces.get(member)!;
        force.x += x;
        force.y += y;
      }
    };
    const entities: Entity[] = [
      ...nodes.map((node) => ({
        id: node.id,
        parent: node.boundaryParent,
        nodes: [node],
        rect: rectFor([node]),
      })),
      ...boundaries.flatMap((boundary) => {
        const members = membersOf(boundary.id, nodes, boundaryById);
        return members.length
          ? [
              {
                id: boundary.id,
                parent: boundary.parent ?? null,
                nodes: members,
                rect: rectFor(members),
              },
            ]
          : [];
      }),
    ];

    const collisionScale = Math.min(
      1,
      (iteration + 1) / Math.max(1, options.collisionRampIterations),
    );
    for (let first = 0; first < nodes.length; first++) {
      for (let second = first + 1; second < nodes.length; second++) {
        const a = nodes[first];
        const b = nodes[second];
        const positionDx = b.x - a.x;
        const positionDy = b.y - a.y;
        const relativeVelocity = {
          x: velocities.get(b)!.x - velocities.get(a)!.x,
          y: velocities.get(b)!.y - velocities.get(a)!.y,
        };
        const dx = positionDx || relativeVelocity.x || (a.id < b.id ? 1 : -1);
        const dy = positionDy || relativeVelocity.y;
        const distance = Math.hypot(dx, dy);
        const clearance =
          Math.hypot((a.width + b.width) / 2, (a.height + b.height) / 2) +
          options.nodeGap;
        if (distance >= clearance) continue;
        const scale =
          (options.nodeRepulsion * collisionScale * (clearance - distance)) /
          clearance;
        addForce([a], (-dx / distance) * scale, (-dy / distance) * scale);
        addForce([b], (dx / distance) * scale, (dy / distance) * scale);
      }
    }

    const entitiesByParent = new Map<string | null, Entity[]>();
    for (const entity of entities) {
      const siblings = entitiesByParent.get(entity.parent) ?? [];
      siblings.push(entity);
      entitiesByParent.set(entity.parent, siblings);
    }
    for (const siblings of entitiesByParent.values()) {
      if (siblings.length < 2) continue;
      const applyOutlierPressure = (axis: "x" | "y", direction: -1 | 1) => {
        const start = axis === "x" ? "minX" : "minY";
        const end = axis === "x" ? "maxX" : "maxY";
        const ordered = [...siblings].sort(
          (a, b) =>
            direction * (a.rect[start] - b.rect[start]) ||
            a.id.localeCompare(b.id),
        );
        const outlier = ordered[0];
        const looseNode =
          outlier.nodes.length === 1 && !connectedNodes.has(outlier.nodes[0]);
        if (!looseNode) return;
        addForce(
          outlier.nodes,
          axis === "x" ? direction * options.edgePressure : 0,
          axis === "y" ? direction * options.edgePressure : 0,
        );
      };
      applyOutlierPressure("x", 1);
      applyOutlierPressure("x", -1);
      applyOutlierPressure("y", 1);
      applyOutlierPressure("y", -1);
    }

    for (const edge of edges) {
      const source = endpoint(edge, "source");
      const target = endpoint(edge, "target");
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.hypot(dx, dy) || 1;
      const scale =
        (options.edgeAttraction * (distance - options.linkLength)) /
        options.linkLength;
      addForce([source], (dx / distance) * scale, (dy / distance) * scale);
      addForce([target], (-dx / distance) * scale, (-dy / distance) * scale);
    }

    const neighborsByNode = new Map<LayoutNode, LayoutNode[]>();
    for (const edge of edges) {
      const source = endpoint(edge, "source");
      const target = endpoint(edge, "target");
      if (source === target) continue;
      const sourceNeighbors = neighborsByNode.get(source) ?? [];
      sourceNeighbors.push(target);
      neighborsByNode.set(source, sourceNeighbors);
      const targetNeighbors = neighborsByNode.get(target) ?? [];
      targetNeighbors.push(source);
      neighborsByNode.set(target, targetNeighbors);
    }
    for (const [hub, neighbors] of neighborsByNode) {
      for (let first = 0; first < neighbors.length; first++) {
        for (let second = first + 1; second < neighbors.length; second++) {
          const a = neighbors[first];
          const b = neighbors[second];
          const ax = a.x - hub.x;
          const ay = a.y - hub.y;
          const bx = b.x - hub.x;
          const by = b.y - hub.y;
          const aLength = Math.hypot(ax, ay);
          const bLength = Math.hypot(bx, by);
          if (!aLength || !bLength) continue;
          const cross = ax * by - ay * bx;
          const cosine = Math.max(
            -1,
            Math.min(1, (ax * bx + ay * by) / (aLength * bLength)),
          );
          const angle = Math.acos(cosine);
          if (angle >= MINIMUM_ANGULAR_GAP) continue;
          const direction = cross || (a.id < b.id ? 1 : -1);
          const scale =
            options.angularSeparation * (1 - angle / MINIMUM_ANGULAR_GAP);
          const aForce = {
            x: (ay / aLength) * Math.sign(direction) * scale,
            y: (-ax / aLength) * Math.sign(direction) * scale,
          };
          const bForce = {
            x: (-by / bLength) * Math.sign(direction) * scale,
            y: (bx / bLength) * Math.sign(direction) * scale,
          };
          addForce([a], aForce.x, aForce.y);
          addForce([b], bForce.x, bForce.y);
          addForce([hub], -aForce.x - bForce.x, -aForce.y - bForce.y);
        }
      }
    }

    for (const entity of entities) {
      const siblings = entities.filter(
        (other) => other !== entity && other.parent === entity.parent,
      );
      if (!siblings.length) continue;
      const own = center(entity.rect);
      const requiredDistance = (sibling: Entity) =>
        Math.hypot(
          (entity.rect.maxX -
            entity.rect.minX +
            sibling.rect.maxX -
            sibling.rect.minX) /
            2,
          (entity.rect.maxY -
            entity.rect.minY +
            sibling.rect.maxY -
            sibling.rect.minY) /
            2,
        ) + options.nodeGap;
      const nearestSiblingDistance = Math.min(
        ...siblings.map((sibling) => {
          const point = center(sibling.rect);
          return Math.hypot(point.x - own.x, point.y - own.y);
        }),
      );
      const nearestRequiredDistance = Math.min(
        ...siblings.map(requiredDistance),
      );
      const average = siblings.reduce(
        (sum, sibling) => {
          const point = center(sibling.rect);
          return {
            x: sum.x + point.x / siblings.length,
            y: sum.y + point.y / siblings.length,
          };
        },
        { x: 0, y: 0 },
      );
      if (nearestSiblingDistance > nearestRequiredDistance) {
        addForce(
          entity.nodes,
          (average.x - own.x) * options.siblingAttraction,
          (average.y - own.y) * options.siblingAttraction,
        );
      }
      for (const sibling of siblings.filter((other) => entity.id < other.id)) {
        const a = center(entity.rect);
        const b = center(sibling.rect);
        const dx = b.x - a.x || 1;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        const required = requiredDistance(sibling);
        if (distance >= required) continue;
        const scale =
          (options.boundaryRepulsion * (required - distance)) / required;
        addForce(
          entity.nodes,
          (-dx / distance) * scale,
          (-dy / distance) * scale,
        );
        addForce(
          sibling.nodes,
          (dx / distance) * scale,
          (dy / distance) * scale,
        );
      }
    }

    for (let first = 0; first < edges.length; first++) {
      const a = endpoint(edges[first], "source");
      const b = endpoint(edges[first], "target");
      for (let second = first + 1; second < edges.length; second++) {
        const c = endpoint(edges[second], "source");
        const d = endpoint(edges[second], "target");
        if (
          a === c ||
          a === d ||
          b === c ||
          b === d ||
          !segmentsCross(a, b, c, d)
        )
          continue;
        const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
        addForce(
          [c],
          normal.x * options.crossingRepulsion,
          normal.y * options.crossingRepulsion,
        );
        addForce(
          [d],
          -normal.x * options.crossingRepulsion,
          -normal.y * options.crossingRepulsion,
        );
      }
    }

    const cooling = 1 - iteration / Math.max(1, options.iterations - 1);
    const maximumStep = Math.max(options.minimumStep, options.step * cooling);
    let maximumForce = 0;
    let maximumDisplacement = 0;
    for (const node of nodes) {
      const force = forces.get(node)!;
      maximumForce = Math.max(maximumForce, Math.hypot(force.x, force.y));
      const velocity = velocities.get(node)!;
      velocity.x = velocity.x * options.damping + force.x;
      velocity.y = velocity.y * options.damping + force.y;
      const velocityMagnitude = Math.hypot(velocity.x, velocity.y);
      if (velocityMagnitude > maximumStep) {
        const scale = maximumStep / velocityMagnitude;
        velocity.x *= scale;
        velocity.y *= scale;
      }
      maximumDisplacement = Math.max(
        maximumDisplacement,
        Math.hypot(velocity.x, velocity.y),
      );
      node.x += velocity.x;
      node.y += velocity.y;
    }
    completedIterations = iteration + 1;
    stable =
      maximumForce <= options.convergenceThreshold &&
      maximumDisplacement <= options.convergenceThreshold
        ? stable + 1
        : 0;
    if (every > 0 && completedIterations % every === 0) {
      snapshots.push(captureSnapshot(completedIterations));
    }
    if (stable >= options.stableIterations) break;
  }
  if (every > 0 && snapshots.at(-1)?.iteration !== completedIterations) {
    snapshots.push(captureSnapshot(completedIterations));
  }
  return snapshots;
}
