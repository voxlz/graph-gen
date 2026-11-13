// bundle.ts — precompiled renderer for tools that start one process per graph.
//
// Running src/index.ts through tsx transpiles every source file on each start
// (~0.2–0.4 s per render). The watcher, render-all and generate instead run a
// single esbuild bundle (dist/index.js) with plain node, rebuilding it whenever
// a source file or package.json is newer. Output is identical either way.

import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(__dirname, "..");
const sourceDir = path.join(rootDir, "src");
// Must sit one level below the repo root: index.ts and render.ts find
// style.jsonc via `${__dirname}/..`.
export const bundlePath = path.join(rootDir, "dist", "index.js");

function newestSourceTime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const time = entry.isDirectory()
      ? newestSourceTime(file)
      : entry.name.endsWith(".ts")
        ? fs.statSync(file).mtimeMs
        : 0;
    newest = Math.max(newest, time);
  }
  return newest;
}

function bundleIsCurrent(): boolean {
  if (!fs.existsSync(bundlePath)) return false;
  const built = fs.statSync(bundlePath).mtimeMs;
  const packageTime = fs.statSync(path.join(rootDir, "package.json")).mtimeMs;
  return built >= Math.max(newestSourceTime(sourceDir), packageTime);
}

export function buildBundle(): void {
  // Loaded lazily so plain renders never pay for esbuild.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const esbuild = require("esbuild") as typeof import("esbuild");
  // Build to a temporary file and rename, so a process starting meanwhile never
  // runs a half-written bundle.
  const temporary = `${bundlePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  esbuild.buildSync({
    entryPoints: [path.join(sourceDir, "index.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    // esbuild is only needed to (re)build this bundle from the watcher.
    external: ["canvas", "esbuild"],
    outfile: temporary,
    logLevel: "warning",
  });
  fs.renameSync(temporary, bundlePath);
}

// Command that renders one graph: `<command> ...args <input> [output]`.
// Falls back to tsx on the source when the bundle can't be built.
export function rendererCommand(): { command: string; args: string[] } {
  try {
    if (!bundleIsCurrent()) buildBundle();
    return { command: process.execPath, args: [bundlePath] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[bundle] falling back to tsx: ${message}`);
    return { command: "tsx", args: [path.join(sourceDir, "index.ts")] };
  }
}

// Run directly (npm run build); the file-name check keeps this from firing
// inside the bundle itself.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === __filename &&
  /bundle\.[jt]s$/.test(__filename)
) {
  buildBundle();
  console.log(`Built ${path.relative(rootDir, bundlePath)}`);
}
