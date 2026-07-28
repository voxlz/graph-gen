import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, type CanvasRenderingContext2D } from "canvas";
import { minimizeBlockerEscapes } from "../../src/strategies/blocker-escape";
import { minimizeTowardCenter } from "../../src/strategies/center";
import { minimizeDisconnectedPerimeter } from "../../src/strategies/disconnected-perimeter";
import { minimizeEdgeLengths } from "../../src/strategies/edge-shortening";
import { minimizeNodeSwaps } from "../../src/strategies/node-swap";
import { minimizeAngularRelaxation } from "../../src/strategies/angular-relaxation";
import { minimizeSharedHubCompaction } from "../../src/strategies/shared-hub-compaction";
import { minimizeElementAlignment } from "../../src/strategies/element-alignment";
import {
  compactness,
  measureBounds,
  nodeRect,
} from "../../src/strategies/shared";
import type {
  MinimizeMeasure,
  MinimizeRect,
  StrategyFrame,
} from "../../src/strategies/types";
import {
  createStrategyCase,
  fixtureBoundaryRects,
  type StrategyFixture,
} from "./fixture";

const WIDTH = 1200;
const HEIGHT = 720;
const HEADER_HEIGHT = 100;
const PADDING = 52;
const OUTPUT_ROOT = join(process.cwd(), "renders", "strategies");
const STRATEGIES = [
  "center",
  "edge-shortening",
  "blocker-escape",
  "angular-relaxation",
  "shared-hub-compaction",
  "node-swap",
  "node-swap-boundary",
  "element-alignment",
  "disconnected-perimeter",
] as const;

function frameMeasure(
  fixture: StrategyFixture,
  frame: StrategyFrame,
): MinimizeMeasure {
  const nodeById = new Map(frame.nodes.map((node) => [node.id, node]));
  const frameNodes = frame.nodes.map((node) => ({
    ...node,
    boundaryParent:
      fixture.nodes.find((fixtureNode) => fixtureNode.id === node.id)
        ?.boundaryParent ?? null,
  }));
  return {
    rects: [
      ...frameNodes.map((node) => nodeRect(node)),
      ...fixtureBoundaryRects(fixture, frameNodes).map((boundary) => ({
        minX: boundary.minX,
        minY: boundary.minY,
        maxX: boundary.maxX,
        maxY: boundary.maxY,
      })),
    ],
    edgeLength: fixture.edges.reduce((sum, [sourceId, targetId]) => {
      const source = nodeById.get(sourceId)!;
      const target = nodeById.get(targetId)!;
      return sum + Math.hypot(target.x - source.x, target.y - source.y);
    }, 0),
  };
}

function transform(viewport: MinimizeRect): {
  scale: number;
  x: (value: number) => number;
  y: (value: number) => number;
} {
  const drawWidth = WIDTH - PADDING * 2;
  const drawHeight = HEIGHT - HEADER_HEIGHT - PADDING * 2;
  const scale = Math.min(
    drawWidth / (viewport.maxX - viewport.minX),
    drawHeight / (viewport.maxY - viewport.minY),
  );
  const offsetX =
    PADDING + (drawWidth - (viewport.maxX - viewport.minX) * scale) / 2;
  const offsetY =
    HEADER_HEIGHT +
    PADDING +
    (drawHeight - (viewport.maxY - viewport.minY) * scale) / 2;
  return {
    scale,
    x: (value) => offsetX + (value - viewport.minX) * scale,
    y: (value) => offsetY + (value - viewport.minY) * scale,
  };
}

function drawRect(
  context: CanvasRenderingContext2D,
  rect: MinimizeRect,
  map: ReturnType<typeof transform>,
): void {
  context.strokeRect(
    map.x(rect.minX),
    map.y(rect.minY),
    (rect.maxX - rect.minX) * map.scale,
    (rect.maxY - rect.minY) * map.scale,
  );
}

function renderFrame(
  fixture: StrategyFixture,
  frame: StrategyFrame,
  frameIndex: number,
  outputPath: string,
): void {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext("2d");
  const map = transform(fixture.viewport);
  const measure = frameMeasure(fixture, frame);
  const bounds = measureBounds(measure.rects)!;
  const boundsWidth = bounds.maxX - bounds.minX;
  const boundsHeight = bounds.maxY - bounds.minY;
  const score = compactness(measure);
  const nodeById = new Map(frame.nodes.map((node) => [node.id, node]));
  const frameNodes = frame.nodes.map((node) => ({
    ...node,
    boundaryParent:
      fixture.nodes.find((fixtureNode) => fixtureNode.id === node.id)
        ?.boundaryParent ?? null,
  }));
  const boundaries = fixtureBoundaryRects(fixture, frameNodes);

  context.fillStyle = "#f7f4ed";
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = "#16324f";
  context.fillRect(0, 0, WIDTH, HEADER_HEIGHT);
  context.fillStyle = "#ffffff";
  context.font = "600 28px Avenir Next";
  context.fillText(fixture.name, PADDING, 44);
  context.fillStyle = "#cfe0ee";
  context.font = "16px Avenir Next";
  context.fillText(
    `iteration ${String(frameIndex).padStart(4, "0")}  |  bounds ${Math.round(boundsWidth).toLocaleString()} x ${Math.round(boundsHeight).toLocaleString()}  |  area ${Math.round(score.area).toLocaleString()}  |  edge length ${Math.round(score.edgeLength).toLocaleString()}`,
    PADDING,
    74,
  );

  context.save();
  context.fillStyle = "rgba(193, 73, 36, 0.10)";
  context.strokeStyle = "#c14924";
  context.lineWidth = 3;
  context.setLineDash([12, 8]);
  context.fillRect(
    map.x(bounds.minX),
    map.y(bounds.minY),
    boundsWidth * map.scale,
    boundsHeight * map.scale,
  );
  drawRect(context, bounds, map);
  context.restore();

  context.save();
  context.setLineDash([10, 7]);
  context.lineWidth = 2;
  context.strokeStyle = "#3f7d78";
  context.fillStyle = "#dcebe5";
  for (const boundary of boundaries) {
    context.fillRect(
      map.x(boundary.minX),
      map.y(boundary.minY),
      (boundary.maxX - boundary.minX) * map.scale,
      (boundary.maxY - boundary.minY) * map.scale,
    );
    drawRect(context, boundary, map);
    context.fillStyle = "#285f5a";
    context.font = "600 14px Avenir Next";
    context.fillText(
      boundary.id,
      map.x(boundary.minX) + 10,
      map.y(boundary.minY) + 22,
    );
    context.fillStyle = "#dcebe5";
  }
  context.restore();

  context.lineWidth = 3;
  context.strokeStyle = "#54606b";
  for (const [sourceId, targetId] of fixture.edges) {
    const source = nodeById.get(sourceId)!;
    const target = nodeById.get(targetId)!;
    context.beginPath();
    context.moveTo(map.x(source.x), map.y(source.y));
    context.lineTo(map.x(target.x), map.y(target.y));
    context.stroke();
  }

  for (const node of frame.nodes) {
    const x = map.x(node.x - node.width / 2);
    const y = map.y(node.y - node.height / 2);
    const width = node.width * map.scale;
    const height = node.height * map.scale;
    context.fillStyle = node.id === "attacker" ? "#f2c14e" : "#f8fafb";
    context.strokeStyle = "#16324f";
    context.lineWidth = 2;
    context.fillRect(x, y, width, height);
    context.strokeRect(x, y, width, height);
    context.fillStyle = "#16324f";
    context.font = "600 15px Avenir Next";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(node.id, map.x(node.x), map.y(node.y), width - 10);
  }

  writeFileSync(outputPath, canvas.toBuffer("image/png"));
}

function runStrategy(name: (typeof STRATEGIES)[number]): void {
  const strategyCase = createStrategyCase(name);
  const initial: StrategyFrame = {
    strategy: name,
    iteration: 0,
    nodes: strategyCase.options.nodes.map(({ id, x, y, width, height }) => ({
      id,
      x,
      y,
      width,
      height,
    })),
  };
  const baseline = compactness(strategyCase.options.measure()!);
  if (name === "center") {
    minimizeTowardCenter(strategyCase.options);
  } else if (name === "edge-shortening") {
    minimizeEdgeLengths(strategyCase.options, baseline.area * 1.05);
  } else if (name === "blocker-escape") {
    minimizeBlockerEscapes(strategyCase.options, baseline.area * 1.05);
  } else if (name === "angular-relaxation") {
    minimizeAngularRelaxation(strategyCase.options, baseline.area * 1.05);
  } else if (name === "shared-hub-compaction") {
    minimizeSharedHubCompaction(strategyCase.options, baseline.area * 1.05);
  } else if (name === "node-swap" || name === "node-swap-boundary") {
    minimizeNodeSwaps(strategyCase.options, baseline.area * 1.05);
  } else if (name === "element-alignment") {
    minimizeElementAlignment(strategyCase.options);
  } else {
    minimizeDisconnectedPerimeter(strategyCase.options, baseline.area * 1.05);
  }

  const outputDirectory = join(OUTPUT_ROOT, name);
  mkdirSync(outputDirectory, { recursive: true });
  for (const [index, frame] of [initial, ...strategyCase.frames].entries()) {
    renderFrame(
      strategyCase.fixture,
      frame,
      index,
      join(outputDirectory, `iteration-${String(index).padStart(4, "0")}.png`),
    );
  }
  console.log(`${name}: ${strategyCase.frames.length + 1} frames`);
}

rmSync(OUTPUT_ROOT, { recursive: true, force: true });
mkdirSync(OUTPUT_ROOT, { recursive: true });
for (const strategy of STRATEGIES) runStrategy(strategy);
