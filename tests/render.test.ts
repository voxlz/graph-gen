import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { segmentHitsBox, type Box } from "../src/routing";
import { emptyGraphSpec, parseGraphText } from "../src/parse";
import {
  formatEdgeLabel,
  prepareEdges,
  renderErrorGraph,
  renderGraph,
  wrapLabel,
} from "../src/render";

function hasClearance(
  box: Box,
  node: { x: number; y: number; width: number; height: number },
  clearance: number,
): boolean {
  const atMost = (a: number, b: number) => a <= b + 1e-6;
  return (
    atMost(box.maxX, node.x - node.width / 2 - clearance) ||
    atMost(node.x + node.width / 2 + clearance, box.minX) ||
    atMost(box.maxY, node.y - node.height / 2 - clearance) ||
    atMost(node.y + node.height / 2 + clearance, box.minY)
  );
}

it("allows rounding at the clearance boundary but rejects real overlap", () => {
  const node = { x: 0, y: 90.67603357703835, width: 2, height: 100 };
  const label = { minX: -1, maxX: 1, minY: 0, maxY: 24.676033577038368 };
  expect(hasClearance(label, node, 16)).toBe(true);
  expect(hasClearance({ ...label, maxY: label.maxY + 0.001 }, node, 16)).toBe(
    false,
  );
});

describe("wrapLabel", () => {
  // One unit per character, so widths are easy to reason about.
  const measure = (line: string) => line.length;

  it("breaks lines at spaces so none exceeds the max width", () => {
    expect(
      wrapLabel("1. GET /a {b}\n2. Return {all the rows}", 12, measure),
    ).toBe("1. GET /a\n{b}\n2. Return\n{all the\nrows}");
  });

  it("keeps a word wider than the max width whole", () => {
    expect(wrapLabel("x averyveryverylongword y", 8, measure)).toBe(
      "x\naveryveryverylongword\ny",
    );
  });
});

describe("renderGraph", () => {
  it.each(["legacy", "both"])(
    "supports %s environment variable names for layout and dumps",
    async (mode) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "graph-gen-env-"),
      );
      const keys = [
        "GRAPHGEN_LAYOUT",
        "GRAPHGEN_DUMP",
        "GRAPH_GEN_LAYOUT",
        "GRAPH_GEN_DUMP",
      ] as const;
      const previous = keys.map((key) => process.env[key]);
      const legacyDump = path.join(directory, "legacy.json");
      const newDump = path.join(directory, "new.json");
      process.env.GRAPHGEN_LAYOUT = "constraint";
      process.env.GRAPHGEN_DUMP = legacyDump;
      delete process.env.GRAPH_GEN_LAYOUT;
      delete process.env.GRAPH_GEN_DUMP;
      if (mode === "both") {
        process.env.GRAPH_GEN_LAYOUT = "curved";
        process.env.GRAPH_GEN_DUMP = newDump;
      }
      try {
        await renderGraph(emptyGraphSpec(), path.join(directory, "render.png"));
        const dump = mode === "both" ? newDump : legacyDump;
        expect(JSON.parse(fs.readFileSync(dump, "utf8")).meta.layout).toBe(
          mode === "both" ? "curved" : "constraint",
        );
        if (mode === "both") expect(fs.existsSync(legacyDump)).toBe(false);
      } finally {
        keys.forEach((key, index) => {
          if (previous[index] === undefined) delete process.env[key];
          else process.env[key] = previous[index];
        });
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    30000,
  );

  it.each([
    ["curved", "circle"],
    ["constraint", "circle"],
    ["curved", "database"],
    ["constraint", "database"],
  ])(
    "connects diagonal edges to a wide %s-mode %s node",
    async (layout, shape) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "graph-gen-rounded-edges-"),
      );
      const previousLayout = process.env.GRAPH_GEN_LAYOUT;
      const previousDump = process.env.GRAPH_GEN_DUMP;
      const dumpPath = path.join(directory, "dump.json");
      process.env.GRAPH_GEN_LAYOUT = layout;
      process.env.GRAPH_GEN_DUMP = dumpPath;
      try {
        const { spec } = parseGraphText(
          fs.readFileSync(
            path.join(__dirname, "../demo/showcase/compass.ggn"),
            "utf8",
          ),
        );
        const centerNode = spec.nodes.find((node) => node.id === "center")!;
        centerNode.label = "A much wider center node";
        centerNode.shape = shape;
        await renderGraph(spec, path.join(directory, "render.png"));
        const dump: {
          nodes: Array<{
            id: string;
            x: number;
            y: number;
            width: number;
            height: number;
          }>;
          edges: Array<{
            source: string;
            target: string;
            points: Array<{ x: number; y: number }>;
          }>;
        } = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
        const center = dump.nodes.find((node) => node.id === "center")!;
        expect(center.width).toBeGreaterThan(center.height);
        const diagonalEdges = dump.edges.filter(
          (edge) =>
            edge.source === "center" &&
            ["nw", "ne", "sw", "se"].includes(edge.target),
        );
        expect(diagonalEdges).toHaveLength(4);
        for (const edge of diagonalEdges) {
          const point = edge.points[0];
          const x = Math.abs(point.x - center.x);
          const y = Math.abs(point.y - center.y);
          if (shape === "circle") {
            const radius = center.height / 2;
            const cornerX = Math.max(0, x - (center.width / 2 - radius));
            expect(Math.hypot(cornerX, y)).toBeCloseTo(radius, 3);
          } else {
            const ry = Math.min(center.height * 0.16, center.width * 0.225);
            const capY = Math.max(0, y - (center.height / 2 - ry));
            if (capY === 0) expect(x).toBeCloseTo(center.width / 2, 3);
            else {
              expect(
                (x / (center.width / 2)) ** 2 + (capY / ry) ** 2,
              ).toBeCloseTo(1, 3);
            }
          }
        }
      } finally {
        if (previousLayout === undefined) delete process.env.GRAPH_GEN_LAYOUT;
        else process.env.GRAPH_GEN_LAYOUT = previousLayout;
        if (previousDump === undefined) delete process.env.GRAPH_GEN_DUMP;
        else process.env.GRAPH_GEN_DUMP = previousDump;
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    30000,
  );

  it("keeps the Weather API to Redis route simple without backtracking", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-gen-weather-scope-"),
    );
    const dumpPath = path.join(directory, "dump.json");
    try {
      execFileSync(
        path.join(__dirname, "../node_modules/.bin/tsx"),
        [
          path.join(__dirname, "../src/index.ts"),
          path.join(__dirname, "../demo/scopes/weather_scope.ggn"),
          path.join(directory, "render"),
        ],
        {
          env: {
            ...process.env,
            GRAPH_GEN_LAYOUT: "orthogonal",
            GRAPH_GEN_LABEL_NODES: "auto",
            GRAPH_GEN_DUMP: dumpPath,
          },
          stdio: "pipe",
        },
      );
      const dump: {
        nodes: Array<{
          id: string;
          x: number;
          y: number;
          width: number;
          height: number;
        }>;
        edges: Array<{
          source: string;
          target: string;
          points: Array<{ x: number; y: number }>;
        }>;
      } = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      const edge = dump.edges.find(
        (item) => item.source === "api" && item.target === "cache",
      )!;
      expect(edge).toBeDefined();
      expect(edge.points.length - 2).toBeLessThanOrEqual(2);
      for (let i = 1; i < edge.points.length - 1; i++) {
        const a = edge.points[i - 1],
          b = edge.points[i],
          c = edge.points[i + 1];
        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
        expect(Math.abs(cross) < 1e-6 && dot < -1e-6).toBe(false);
      }
      for (const node of dump.nodes.filter(
        (item) => item.id !== "api" && item.id !== "cache",
      )) {
        const box = {
          minX: node.x - node.width / 2,
          maxX: node.x + node.width / 2,
          minY: node.y - node.height / 2,
          maxY: node.y + node.height / 2,
        };
        expect(
          edge.points
            .slice(1)
            .some((point, i) => segmentHitsBox(edge.points[i], point, box)),
        ).toBe(false);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);

  it.each(["curved", "orthogonal", "constraint", "force", "cola"])(
    "keeps group titles clear of nodes, edges and labels in %s mode",
    async (layout) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "graph-gen-group-labels-"),
      );
      const previousLayout = process.env.GRAPH_GEN_LAYOUT;
      const previousDump = process.env.GRAPH_GEN_DUMP;
      process.env.GRAPH_GEN_LAYOUT = layout;
      process.env.GRAPH_GEN_DUMP = path.join(directory, "dump.json");
      try {
        const spec = emptyGraphSpec();
        spec.graph.boundaryPad = 0;
        spec.graph.labelBand = 0;
        spec.graph.nestPad = 0;
        spec.boundaries = [
          {
            id: "outer",
            label: "Outer group with a long title\nand a second line",
            parent: null,
          },
          {
            id: "inner",
            label: "Inner group with another long title",
            parent: "outer",
          },
          { id: "hidden", label: "Not drawn", parent: null, draw: false },
        ];
        spec.nodes = [
          { id: "source", label: "Source", shape: "box", parent: null },
          { id: "target", label: "Target", shape: "box", parent: "inner" },
          { id: "peer", label: "Peer", shape: "box", parent: "inner" },
          {
            id: "hidden-node",
            label: "Hidden group member",
            shape: "box",
            parent: "hidden",
          },
        ];
        spec.edges = [{ source: "source", target: "target", label: "Request" }];
        await renderGraph(spec, path.join(directory, "render"));
        type Box = { minX: number; maxX: number; minY: number; maxY: number };
        const dump: {
          nodes: Array<{ x: number; y: number; width: number; height: number }>;
          groups: Array<{ id: string; rect: Box; label: Box | null }>;
          edges: Array<{ points: Array<{ x: number; y: number }> }>;
          labels: Box[];
        } = JSON.parse(fs.readFileSync(process.env.GRAPH_GEN_DUMP, "utf8"));
        const titles = dump.groups.flatMap((group) =>
          group.label ? [group.label] : [],
        );
        expect(titles).toHaveLength(2);
        expect(
          dump.groups.find((group) => group.id === "hidden")!.label,
        ).toBeNull();
        const overlaps = (a: Box, b: Box) =>
          a.minX < b.maxX &&
          a.maxX > b.minX &&
          a.minY < b.maxY &&
          a.maxY > b.minY;
        for (const [index, title] of titles.entries()) {
          for (const other of [...titles.slice(index + 1), ...dump.labels]) {
            expect(overlaps(title, other)).toBe(false);
          }
          for (const node of dump.nodes) {
            expect(
              overlaps(title, {
                minX: node.x - node.width / 2,
                maxX: node.x + node.width / 2,
                minY: node.y - node.height / 2,
                maxY: node.y + node.height / 2,
              }),
            ).toBe(false);
          }
          for (const edge of dump.edges) {
            expect(
              edge.points
                .slice(1)
                .some((point, i) =>
                  segmentHitsBox(edge.points[i], point, title),
                ),
            ).toBe(false);
          }
        }
      } finally {
        if (previousLayout === undefined) delete process.env.GRAPH_GEN_LAYOUT;
        else process.env.GRAPH_GEN_LAYOUT = previousLayout;
        if (previousDump === undefined) delete process.env.GRAPH_GEN_DUMP;
        else process.env.GRAPH_GEN_DUMP = previousDump;
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    30000,
  );

  it("writes a PNG for an empty graph", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-gen-render-"),
    );
    const output = path.join(directory, "graph.png");

    try {
      const result = await renderGraph(emptyGraphSpec(), output);

      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      expect(fs.statSync(output).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the curved layout by default", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-gen-render-curved-default-"),
    );
    const output = path.join(directory, "graph.png");
    const dump = path.join(directory, "dump.json");
    const previousLayout = process.env.GRAPH_GEN_LAYOUT;
    const previousDump = process.env.GRAPH_GEN_DUMP;
    delete process.env.GRAPH_GEN_LAYOUT;
    process.env.GRAPH_GEN_DUMP = dump;

    try {
      await renderGraph(emptyGraphSpec(), output);

      expect(JSON.parse(fs.readFileSync(dump, "utf8")).meta.layout).toBe(
        "curved",
      );
    } finally {
      for (const [key, value] of [
        ["GRAPH_GEN_LAYOUT", previousLayout],
        ["GRAPH_GEN_DUMP", previousDump],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders a graph with the force layout strategy", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-gen-render-force-"),
    );
    const output = path.join(directory, "graph.png");
    const spec = emptyGraphSpec();
    spec.graph.layout = "force";
    spec.nodes = [
      { id: "source", label: "Source", shape: "box", parent: null },
      { id: "target", label: "Target", shape: "box", parent: null },
      { id: "blocker", label: "Blocker", shape: "box", parent: null },
    ];
    spec.edges = [{ source: "source", target: "target" }];

    try {
      const result = await renderGraph(spec, output);

      expect(result.width).toBeGreaterThan(0);
      expect(fs.statSync(output).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["compass", "example"])(
    "keeps orthogonal bends visible and clear connections straight: %s",
    async (name) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "graph-gen-orthogonal-"),
      );

      const dumpPath = path.join(directory, "dump.json");
      const previousLayout = process.env.GRAPH_GEN_LAYOUT;
      const previousDump = process.env.GRAPH_GEN_DUMP;
      process.env.GRAPH_GEN_LAYOUT = "orthogonal";
      process.env.GRAPH_GEN_DUMP = dumpPath;
      try {
        const { spec } = parseGraphText(
          fs.readFileSync(
            path.join(__dirname, `../demo/showcase/${name}.ggn`),
            "utf8",
          ),
        );
        execFileSync(
          path.join(__dirname, "../node_modules/.bin/tsx"),
          [
            path.join(__dirname, "../src/index.ts"),
            path.join(__dirname, `../demo/showcase/${name}.ggn`),
            path.join(directory, `${name}.png`),
          ],
          { env: process.env, stdio: "pipe" },
        );
        const dump: {
          edges: Array<{
            source: string;
            target: string;
            points: Array<{ x: number; y: number }>;
          }>;
          labels: Array<{
            minX: number;
            minY: number;
            maxX: number;
            maxY: number;
          }>;
        } = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
        if (name === "compass") {
          const edge = dump.edges.find(
            (edge) => edge.source === "center" && edge.target === "s",
          );
          expect(edge).toBeDefined();
          expect(edge!.points).toHaveLength(2);
          expect(edge!.points[0].x).toBeCloseTo(edge!.points[1].x);
        }
        expect(dump.labels).toHaveLength(
          spec.edges.filter((edge) => edge.label).length,
        );
        for (const label of dump.labels) {
          for (const edge of dump.edges) {
            for (const bend of edge.points.slice(1, -1)) {
              expect(
                bend.x > label.minX &&
                  bend.x < label.maxX &&
                  bend.y > label.minY &&
                  bend.y < label.maxY,
              ).toBe(false);
            }
          }
        }
      } finally {
        for (const [key, value] of [
          ["GRAPH_GEN_LAYOUT", previousLayout],
          ["GRAPH_GEN_DUMP", previousDump],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    30000,
  );

  it("compacts bookstore providers while keeping orthogonal labels and routes clear", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-gen-bookstore-"),
    );
    const dumpPath = path.join(directory, "dump.json");
    try {
      const output = execFileSync(
        path.join(__dirname, "../node_modules/.bin/tsx"),
        [
          path.join(__dirname, "../src/index.ts"),
          path.join(__dirname, "../demo/usecases/bookstore_uc2.ggn"),
          path.join(directory, "render"),
        ],
        {
          env: {
            ...process.env,
            GRAPH_GEN_LAYOUT: "orthogonal",
            GRAPH_GEN_LABEL_NODES: "auto",
            GRAPH_GEN_DUMP: dumpPath,
          },
          encoding: "utf8",
          stdio: "pipe",
        },
      );
      const size = output.match(/\((\d+)x(\d+)\)/);
      expect(size).not.toBeNull();
      expect(Number(size![1])).toBeLessThanOrEqual(900);
      expect(Number(size![1]) * Number(size![2])).toBeLessThan(1100000);
      const dump: {
        nodes: Array<{
          id: string;
          x: number;
          y: number;
          width: number;
          height: number;
        }>;
        groups: Array<{
          id: string;
          rect: { minX: number; maxX: number };
        }>;
        edges: Array<{
          source: string;
          target: string;
          points: Array<{ x: number; y: number }>;
        }>;
        labels: Array<{
          source: string;
          target: string;
          minX: number;
          minY: number;
          maxX: number;
          maxY: number;
        }>;
      } = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      const external = dump.groups.find((group) => group.id === "external")!;
      expect(external.rect.maxX - external.rect.minX).toBeLessThanOrEqual(380);
      for (let i = 0; i < dump.nodes.length; i++) {
        for (let j = i + 1; j < dump.nodes.length; j++) {
          const a = dump.nodes[i];
          const b = dump.nodes[j];
          expect(
            Math.abs(a.x - b.x) >= (a.width + b.width) / 2 + 100 - 0.01 ||
              Math.abs(a.y - b.y) >= (a.height + b.height) / 2 + 100 - 0.01,
          ).toBe(true);
        }
      }
      for (const route of dump.edges) {
        for (const node of dump.nodes) {
          if (node.id === route.source || node.id === route.target) continue;
          const box = {
            minX: node.x - node.width / 2,
            maxX: node.x + node.width / 2,
            minY: node.y - node.height / 2,
            maxY: node.y + node.height / 2,
          };
          expect(
            route.points
              .slice(1)
              .some((point, i) => segmentHitsBox(route.points[i], point, box)),
          ).toBe(false);
        }
      }
      for (const item of dump.labels) {
        for (const route of dump.edges) {
          for (const bend of route.points.slice(1, -1)) {
            expect(
              bend.x > item.minX - 10 + 1e-6 &&
                bend.x < item.maxX + 10 - 1e-6 &&
                bend.y > item.minY - 10 + 1e-6 &&
                bend.y < item.maxY + 10 - 1e-6,
            ).toBe(false);
          }
        }
        const route = dump.edges.find(
          (edge) => edge.source === item.source && edge.target === item.target,
        )!;
        const dx = Math.min(
          (item.maxX - item.minX) / 4,
          Math.max(2, (item.maxX - item.minX) / 2 - 24),
        );
        const dy = Math.min(
          (item.maxY - item.minY) / 4,
          Math.max(2, (item.maxY - item.minY) / 2 - 24),
        );
        const core = {
          minX: item.minX + dx,
          maxX: item.maxX - dx,
          minY: item.minY + dy,
          maxY: item.maxY - dy,
        };
        expect(
          route.points
            .slice(1)
            .some((point, i) => segmentHitsBox(route.points[i], point, core)),
        ).toBe(true);
      }
      const edge = dump.edges.find(
        (item) => item.source === "orders" && item.target === "postgres",
      )!;
      const label = dump.labels.find(
        (item) => item.source === "orders" && item.target === "postgres",
      )!;
      expect(edge).toBeDefined();
      expect(label).toBeDefined();
      const core = {
        minX: (label.minX * 3 + label.maxX) / 4,
        maxX: (label.minX + label.maxX * 3) / 4,
        minY: (label.minY * 3 + label.maxY) / 4,
        maxY: (label.minY + label.maxY * 3) / 4,
      };
      expect(
        edge.points
          .slice(1)
          .some((point, i) => segmentHitsBox(edge.points[i], point, core)),
      ).toBe(true);
      for (const point of edge.points.slice(1, -1)) {
        expect(
          point.x > label.minX &&
            point.x < label.maxX &&
            point.y > label.minY &&
            point.y < label.maxY,
        ).toBe(false);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);

  it("compacts disconnected weather nodes with automatic label nodes", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-gen-weather-"),
    );
    const dumpPath = path.join(directory, "dump.json");
    try {
      const output = execFileSync(
        path.join(__dirname, "../node_modules/.bin/tsx"),
        [
          path.join(__dirname, "../src/index.ts"),
          path.join(__dirname, "../demo/usecases/weather_uc1.ggn"),
          path.join(directory, "render"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GRAPH_GEN_LAYOUT: "orthogonal",
            GRAPH_GEN_LABEL_NODES: "auto",
            GRAPH_GEN_DUMP: dumpPath,
          },
        },
      );
      const size = output.match(/\((\d+)x(\d+)\)/);
      expect(size).not.toBeNull();
      expect(Number(size![1])).toBeLessThanOrEqual(1200);
      expect(Number(size![1]) * Number(size![2])).toBeLessThan(900000);
      const dump: {
        nodes: Array<{
          id: string;
          x: number;
          y: number;
          width: number;
          height: number;
        }>;
        edges: Array<{
          source: string;
          target: string;
          points: Array<{ x: number; y: number }>;
        }>;
        labels: Array<{
          source: string;
          target: string;
          minX: number;
          minY: number;
          maxX: number;
          maxY: number;
        }>;
      } = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
      for (let i = 0; i < dump.nodes.length; i++) {
        for (let j = i + 1; j < dump.nodes.length; j++) {
          const a = dump.nodes[i];
          const b = dump.nodes[j];
          expect(
            Math.abs(a.x - b.x) >= (a.width + b.width) / 2 + 150 - 0.01 ||
              Math.abs(a.y - b.y) >= (a.height + b.height) / 2 + 150 - 0.01,
          ).toBe(true);
        }
      }
      for (const label of dump.labels) {
        for (const node of dump.nodes) {
          expect(hasClearance(label, node, 16)).toBe(true);
        }
        for (const other of dump.edges) {
          for (const bend of other.points.slice(1, -1)) {
            expect(
              bend.x > label.minX - 10 + 1e-6 &&
                bend.x < label.maxX + 10 - 1e-6 &&
                bend.y > label.minY - 10 + 1e-6 &&
                bend.y < label.maxY + 10 - 1e-6,
            ).toBe(false);
          }
        }
        const edge = dump.edges.find(
          (item) =>
            item.source === label.source && item.target === label.target,
        )!;
        expect(edge).toBeDefined();
        const inset = (half: number) =>
          Math.min(half / 2, Math.max(2, half - 24));
        const dx = inset((label.maxX - label.minX) / 2);
        const dy = inset((label.maxY - label.minY) / 2);
        const core = {
          minX: label.minX + dx,
          maxX: label.maxX - dx,
          minY: label.minY + dy,
          maxY: label.maxY - dy,
        };
        expect(
          edge.points
            .slice(1)
            .some((p, i) => segmentHitsBox(edge.points[i], p, core)),
        ).toBe(true);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);

  it.each(["auto", "true", "false"])(
    "respects the orthogonal label-node setting (%s)",
    async (setting) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "graph-gen-label-node-"),
      );
      const dumpPath = path.join(directory, "dump.json");
      const previous = {
        layout: process.env.GRAPH_GEN_LAYOUT,
        labelNodes: process.env.GRAPH_GEN_LABEL_NODES,
        dump: process.env.GRAPH_GEN_DUMP,
      };
      process.env.GRAPH_GEN_LAYOUT = "orthogonal";
      process.env.GRAPH_GEN_LABEL_NODES = setting;
      process.env.GRAPH_GEN_DUMP = dumpPath;
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const spec = emptyGraphSpec();
        spec.graph.labelMaxWidth = 0;
        spec.nodes = [
          { id: "a", label: "A", shape: "box", parent: null },
          { id: "b", label: "B", shape: "box", parent: null },
        ];
        spec.edges = [
          {
            source: "a",
            target: "b",
            label:
              "a really long label that should force a label node to push the two endpoints apart and produce a direct orthogonal route",
          },
        ];
        await renderGraph(spec, path.join(directory, "render"));
        const dump: {
          edges: Array<{ points: Array<{ x: number; y: number }> }>;
          labels: Array<{
            minX: number;
            minY: number;
            maxX: number;
            maxY: number;
          }>;
        } = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
        const points = dump.edges[0].points;
        const label = dump.labels[0];
        const core = {
          minX: (label.minX * 3 + label.maxX) / 4,
          maxX: (label.minX + label.maxX * 3) / 4,
          minY: (label.minY * 3 + label.maxY) / 4,
          maxY: (label.minY + label.maxY * 3) / 4,
        };
        expect(
          points.slice(1).some((p, i) => segmentHitsBox(points[i], p, core)),
        ).toBe(setting !== "false");
        if (setting === "false") {
          expect(warn).toHaveBeenCalledWith(
            "[orthogonal] could not route a -> b through its label",
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
        for (const point of points.slice(1, -1)) {
          expect(
            point.x > label.minX &&
              point.x < label.maxX &&
              point.y > label.minY &&
              point.y < label.maxY,
          ).toBe(false);
        }
        for (let i = 1; i < points.length; i++) {
          expect(
            points[i].x === points[i - 1].x || points[i].y === points[i - 1].y,
          ).toBe(true);
        }
      } finally {
        warn.mockRestore();
        for (const [key, value] of [
          ["GRAPH_GEN_LAYOUT", previous.layout],
          ["GRAPH_GEN_LABEL_NODES", previous.labelNodes],
          ["GRAPH_GEN_DUMP", previous.dump],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    60000,
  );

  it("formats graph edge labels with their index and parsed edge data", () => {
    const edge = {
      source: "customer",
      target: "api",
      label: "GET /orders",
      arrowSource: false,
      arrowTarget: true,
      lineStyle: "solid",
      line: 12,
    };

    expect(
      formatEdgeLabel(
        "{index}. {source} -> {target}: {label} ({lineStyle}, line {line})",
        edge,
        1,
      ),
    ).toBe("2. customer -> api: GET /orders (solid, line 12)");
    expect(formatEdgeLabel("", edge, 1)).toBe("GET /orders");
  });

  it("formats duplicate edge labels before merging them", () => {
    expect(
      prepareEdges(
        [
          {
            source: "customer",
            target: "gateway",
            label: "Request",
            arrowTarget: true,
          },
          {
            source: "gateway",
            target: "customer",
            label: "Response",
            arrowTarget: true,
          },
        ],
        "{index}. {label}",
      ),
    ).toEqual([
      expect.objectContaining({
        source: "customer",
        target: "gateway",
        arrowSource: true,
        arrowTarget: true,
        label: "1. Request\n2. Response",
      }),
    ]);
  });

  it("writes an error PNG with the supplied diagnostics", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-gen-render-"),
    );
    const output = path.join(directory, "error.png");

    try {
      const result = await renderErrorGraph(
        ["[parse] Unbalanced braces in DSL block"],
        output,
      );

      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      expect(fs.statSync(output).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves each diagnostic context line in the PNG", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-gen-render-"),
    );
    const output = path.join(directory, "context.png");

    try {
      const result = await renderErrorGraph(
        [
          "[validate] graph.ggn:5\nERROR: invalid edge\nContext:\n     3 | }\n>    5 |     customer --> missing\n     6 | }",
        ],
        output,
      );

      expect(result.height).toBe(276);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
