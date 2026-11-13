// Watches .ggn files and re-renders them after each save.
// Usage: tsx src/watch.ts [path] [output-directory]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rendererCommand } from "./bundle";
import { parseGraphText } from "./parse";

const rootDir = path.resolve(__dirname, "..");
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export function findGraphFiles(targetPath: string): string[] {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return path.extname(targetPath).toLowerCase() === ".ggn"
      ? [targetPath]
      : [];
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "renders") continue;

    const file = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...findGraphFiles(file));
    } else if (
      entry.isFile() &&
      path.extname(entry.name).toLowerCase() === ".ggn"
    ) {
      files.push(file);
    }
  }
  return files.sort();
}

export function outputPathFor(
  file: string,
  outputDirectory?: string,
): string | undefined {
  if (!outputDirectory) return undefined;

  const outputRoot = path.resolve(outputDirectory);
  const relative = path.relative(rootDir, file);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.join(outputRoot, relative.replace(/\.ggn$/i, ".png"));
  }
  return path.join(
    outputRoot,
    `${path.basename(file, path.extname(file))}.png`,
  );
}

export function findDependentGraphFiles(
  changedFile: string,
  graphFiles: string[],
): string[] {
  const importers = new Map<string, Set<string>>();
  for (const file of graphFiles) {
    try {
      const imports = parseGraphText(fs.readFileSync(file, "utf8")).spec
        .imports;
      for (const imported of imports) {
        const dependency = path.resolve(path.dirname(file), imported);
        if (!importers.has(dependency)) importers.set(dependency, new Set());
        importers.get(dependency)?.add(file);
      }
    } catch {
      // A temporarily unreadable file is retried on its next save event.
    }
  }

  const dependents = new Set<string>();
  const pending = [path.resolve(changedFile)];
  while (pending.length > 0) {
    const dependency = pending.shift() as string;
    for (const importer of importers.get(dependency) ?? []) {
      if (dependents.has(importer)) continue;
      dependents.add(importer);
      pending.push(importer);
    }
  }
  return [...dependents].sort();
}

function printError(message: string) {
  process.stderr.write(`${RED}${message}${RESET}`);
}

// Graphs rendered at the same time: renders are independent processes, so a
// change to a shared scope re-renders all its use cases in parallel.
const MAX_PARALLEL_RENDERS = Math.max(
  1,
  Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1),
);

function renderGraph(
  renderer: { command: string; args: string[] },
  file: string,
  outputDirectory?: string,
): Promise<void> {
  const output = outputPathFor(file, outputDirectory);
  if (output) fs.mkdirSync(path.dirname(output), { recursive: true });

  return new Promise((resolve) => {
    const args = [...renderer.args, file];
    if (output) args.push(output);
    const child = spawn(renderer.command, args, {
      cwd: rootDir,
      // Hint about constraints that block a smaller layout while editing.
      env: {
        ...process.env,
        GRAPHGEN_CONSTRAINT_HINTS: process.env.GRAPHGEN_CONSTRAINT_HINTS ?? "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => printError(chunk.toString()));
    child.on("error", (error) => {
      printError(`[watch] ${file}: ${error.message}\n`);
      resolve();
    });
    child.on("close", (code) => {
      if (code !== 0) printError(`[watch] render failed: ${file}\n`);
      resolve();
    });
  });
}

export function startWatch(
  targetPath = process.cwd(),
  outputDirectory?: string,
) {
  const target = path.resolve(targetPath);
  let targetStat: fs.Stats;
  try {
    targetStat = fs.statSync(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printError(`[watch] ${message}\n`);
    return;
  }

  if (targetStat.isFile() && path.extname(target).toLowerCase() !== ".ggn") {
    printError(`[watch] expected a .ggn file: ${target}\n`);
    return;
  }

  const watchDirectory = targetStat.isDirectory()
    ? target
    : path.dirname(target);
  const watchedFile = targetStat.isFile() ? target : undefined;
  const renderer = rendererCommand();
  const queued = new Set<string>();
  const rendering = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();

  // A file changed again while rendering stays queued and is rendered once
  // more afterwards, so the last render always reflects the latest contents.
  const processQueue = () => {
    while (rendering.size < MAX_PARALLEL_RENDERS) {
      const next = [...queued].sort().find((file) => !rendering.has(file));
      if (!next) return;
      queued.delete(next);
      rendering.add(next);
      void renderGraph(renderer, next, outputDirectory).then(() => {
        rendering.delete(next);
        processQueue();
      });
    }
  };

  const queueFile = (file: string, includeDependents = true) => {
    if (path.extname(file).toLowerCase() !== ".ggn") return;
    const previous = timers.get(file);
    if (previous) clearTimeout(previous);

    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        if (!fs.existsSync(file)) return;
        queued.add(file);
        if (includeDependents) {
          const graphFiles = findGraphFiles(target);
          for (const dependent of findDependentGraphFiles(file, graphFiles)) {
            queueFile(dependent, false);
          }
        }
        processQueue();
      }, 150),
    );
  };

  const initialFiles = findGraphFiles(target);
  console.log(
    `[watch] watching ${target} (${initialFiles.length} .ggn file(s)); waiting for changes`,
  );

  const watcher = fs.watch(
    watchDirectory,
    { recursive: targetStat.isDirectory() },
    (_eventType, filename) => {
      if (!filename) return;
      const changed = path.resolve(watchDirectory, filename.toString());
      if (watchedFile && changed !== watchedFile) return;
      queueFile(changed);
    },
  );

  process.on("SIGINT", () => {
    watcher.close();
    console.log("\n[watch] stopped");
  });
}

// Run directly (tsx src/watch.ts). The file-name check keeps this from firing
// inside the dist/index.js bundle, where every module shares one __filename.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === __filename &&
  /watch\.[jt]s$/.test(__filename)
) {
  startWatch(process.argv[2], process.argv[3]);
}
