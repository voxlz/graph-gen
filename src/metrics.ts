// metrics.ts — measures a rendered graph from its layout dump (GRAPHGEN_DUMP):
// area, drawn edge lengths, crossings, edges through nodes, label collisions,
// overlapping edges and bends. Shared by the benchmark and improve-rules.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { rendererCommand } from "./bundle";

// Resolved on first use, so importing this module never builds the bundle.
let cachedRenderer: ReturnType<typeof rendererCommand> | null = null;
function renderer() {
  cachedRenderer ??= rendererCommand();
  return cachedRenderer;
}

export type Rect = { minX: number; minY: number; maxX: number; maxY: number };
export type Metrics = {
  ok: boolean;
  error?: string;
  ms: number;
  width: number;
  height: number;
  area: number;
  edgeLen: number;
  maxEdge: number;
  cross: number;
  through: number;
  labelHits?: number;
  labelLines?: number;
  bends?: number;
  maxBends?: number;
  overlaps?: number;
  layoutMs?: number;
};

function pngSize(file: string) {
  const buf = fs.readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function rectOf(n: any): Rect {
  return {
    minX: n.x - n.width / 2,
    maxX: n.x + n.width / 2,
    minY: n.y - n.height / 2,
    maxY: n.y + n.height / 2,
  };
}

function clipToBorder(n: any, towardX: number, towardY: number) {
  const dx = towardX - n.x;
  const dy = towardY - n.y;
  if (dx === 0 && dy === 0) return { x: n.x, y: n.y };
  const sx = dx !== 0 ? n.width / 2 / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? n.height / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy, 1);
  return { x: n.x + dx * s, y: n.y + dy * s };
}

type Pt = { x: number; y: number };
function orient(a: Pt, b: Pt, c: Pt) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
function segmentHitsRect(a: Pt, b: Pt, r: Rect) {
  // Liang–Barsky clip against a slightly shrunk rect.
  const shrink = 2;
  const minX = r.minX + shrink;
  const maxX = r.maxX - shrink;
  const minY = r.minY + shrink;
  const maxY = r.maxY - shrink;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: [number, number][] = [
    [-dx, a.x - minX],
    [dx, maxX - a.x],
    [-dy, a.y - minY],
    [dy, maxY - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

// Length along which two polylines run collinearly on top of each other.
function sharedRun(p: Pt[], q: Pt[]): number {
  let total = 0;
  for (let i = 1; i < p.length; i++) {
    for (let j = 1; j < q.length; j++) {
      const a = p[i - 1];
      const b = p[i];
      const c = q[j - 1];
      const d = q[j];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const dist = (r: Pt) => Math.abs(orient(a, b, r)) / len;
      if (dist(c) > 0.5 || dist(d) > 0.5) continue;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const t = (r: Pt) => (r.x - a.x) * ux + (r.y - a.y) * uy;
      const lo = Math.max(0, Math.min(t(c), t(d)));
      const hi = Math.min(len, Math.max(t(c), t(d)));
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

export function metricsFromDump(dump: any) {
  const byId = new Map<string, any>(dump.nodes.map((n: any) => [n.id, n]));
  const paths: { s: string; t: string; points: Pt[]; curve: boolean }[] = [];
  const seen = new Set<string>();
  for (const e of dump.edges ?? []) {
    const key = [e.source, e.target].sort().join("\u0000");
    if (seen.has(key)) continue; // bidirectional pairs draw one visual line
    seen.add(key);
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    paths.push({
      s: e.source,
      t: e.target,
      curve: Boolean(e.curve),
      points: e.points ?? [
        clipToBorder(s, t.x, t.y),
        clipToBorder(t, s.x, s.y),
      ],
    });
  }
  const pathLength = (points: Pt[]) =>
    points
      .slice(1)
      .reduce(
        (sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y),
        0,
      );
  const hitsRect = (points: Pt[], r: Rect) =>
    points.slice(1).some((p, i) => segmentHitsRect(points[i], p, r));
  let edgeLen = 0;
  let maxEdge = 0;
  for (const path of paths) {
    const len = pathLength(path.points);
    edgeLen += len;
    maxEdge = Math.max(maxEdge, len);
  }
  let cross = 0;
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const p = paths[i];
      const q = paths[j];
      // Straight edges sharing a node can't cross; routed ones can.
      const shared = p.s === q.s || p.s === q.t || p.t === q.s || p.t === q.t;
      if (shared && p.points.length === 2 && q.points.length === 2) continue;
      for (let a = 1; a < p.points.length; a++) {
        for (let b = 1; b < q.points.length; b++) {
          if (
            segmentsCross(
              p.points[a - 1],
              p.points[a],
              q.points[b - 1],
              q.points[b],
            )
          )
            cross++;
        }
      }
    }
  }
  let through = 0;
  for (const path of paths) {
    if (
      dump.nodes.some(
        (n: any) =>
          n.id !== path.s &&
          n.id !== path.t &&
          hitsRect(path.points, rectOf(n)),
      )
    ) {
      through++;
    }
  }
  // Labels covering a node or another label, and labels crossed by an edge
  // other than their own (a label may sit on its own edge).
  const labels: Array<Rect & { source?: string; target?: string }> =
    dump.labels ?? [];
  const overlap = (a: Rect, b: Rect) =>
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
  const shrink = (r: Rect, d: number) => ({
    minX: r.minX + d,
    maxX: r.maxX - d,
    minY: r.minY + d,
    maxY: r.maxY - d,
  });
  let labelHits = 0;
  let labelLines = 0;
  labels.forEach((label, i) => {
    const inner = shrink(label, 1);
    if (
      dump.nodes.some((n: any) => overlap(inner, rectOf(n))) ||
      labels.some((other, j) => j !== i && overlap(inner, other))
    ) {
      labelHits++;
    }
    const own = (path: { s: string; t: string }) =>
      (path.s === label.source && path.t === label.target) ||
      (path.s === label.target && path.t === label.source);
    if (paths.some((path) => !own(path) && hitsRect(path.points, inner)))
      labelLines++;
  });
  // Edges drawn on top of each other along a shared stretch (> 2px).
  let overlaps = 0;
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (sharedRun(paths[i].points, paths[j].points) > 2) overlaps++;
    }
  }
  // Interior polyline vertices where the direction actually changes.
  const bendCounts = paths.map((path) =>
    path.curve
      ? 0
      : path.points.slice(1, -1).filter((p, i) => {
          const a = path.points[i];
          const b = path.points[i + 2];
          return (
            Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) >
            1e-3
          );
        }).length,
  );
  const bends = bendCounts.reduce((sum, n) => sum + n, 0);
  const maxBends = Math.max(0, ...bendCounts);
  return {
    edgeLen,
    maxEdge,
    cross,
    through,
    labelHits,
    labelLines,
    bends,
    maxBends,
    overlaps,
  };
}

// Renders one graph in a child process (so engines can't affect each other)
// and measures the result from its image and GRAPHGEN_DUMP layout dump.
export function renderAndMeasure(
  file: string,
  image: string,
  env: Record<string, string>,
): Promise<Metrics> {
  const png = image;
  const dumpFile = image.replace(/\.[a-z]+$/, ".json");
  fs.mkdirSync(path.dirname(png), { recursive: true });
  fs.rmSync(dumpFile, { force: true });
  const start = Date.now();
  return new Promise((resolve) => {
    execFile(
      renderer().command,
      [...renderer().args, file, png],
      {
        env: {
          ...process.env,
          ...env,
          GRAPHGEN_DUMP: dumpFile,
        },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, _stdout, stderr) => {
        const ms = Date.now() - start;
        const failed: Metrics = {
          ok: false,
          ms,
          width: 0,
          height: 0,
          area: 0,
          edgeLen: 0,
          maxEdge: 0,
          cross: 0,
          through: 0,
        };
        if (error || !fs.existsSync(dumpFile)) {
          const message = (stderr || String(error))
            .trim()
            .split("\n")
            .slice(-3)
            .join(" ");
          resolve({ ...failed, error: message });
          return;
        }
        const { width, height } = pngSize(png);
        const dump = JSON.parse(fs.readFileSync(dumpFile, "utf8"));
        resolve({
          ok: true,
          ms,
          width,
          height,
          area: (width * height) / 1e6,
          layoutMs: dump.meta?.layoutMs,
          ...metricsFromDump(dump),
        });
      },
    );
  });
}

export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}
