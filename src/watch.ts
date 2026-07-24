// Watches .ggn files and re-renders them after each save.
// Usage: tsx src/watch.ts [path]

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(__dirname, "..");
const rendersDir = path.join(rootDir, "renders");
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

export function outputPathFor(file: string): string {
  const relative = path.relative(rootDir, file);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.join(rendersDir, relative.replace(/\.ggn$/i, ".png"));
  }
  return path.join(
    rendersDir,
    `${path.basename(file, path.extname(file))}.png`,
  );
}

function printError(message: string) {
  process.stderr.write(`${RED}${message}${RESET}`);
}

function renderGraph(file: string): Promise<void> {
  const output = outputPathFor(file);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  return new Promise((resolve) => {
    const child = spawn(
      "tsx",
      [path.join(__dirname, "index.ts"), file, output],
      {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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

export function startWatch(targetPath = process.cwd()) {
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
  const queued = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();
  let rendering = false;

  const processQueue = async () => {
    if (rendering) return;
    const next = [...queued].sort()[0];
    if (!next) return;

    rendering = true;
    queued.delete(next);
    await renderGraph(next);
    rendering = false;
    void processQueue();
  };

  const queueFile = (file: string) => {
    if (path.extname(file).toLowerCase() !== ".ggn") return;
    const previous = timers.get(file);
    if (previous) clearTimeout(previous);

    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        if (!fs.existsSync(file)) return;
        queued.add(file);
        void processQueue();
      }, 150),
    );
  };

  const initialFiles = findGraphFiles(target);
  console.log(
    `[watch] watching ${target} (${initialFiles.length} .ggn file(s))`,
  );
  for (const file of initialFiles) queueFile(file);

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

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startWatch(process.argv[2]);
}
