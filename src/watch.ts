// Watches .ggn files and re-renders them after each save.
// Usage: tsx src/watch.ts [path] [output-directory]

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

function renderGraph(file: string, outputDirectory?: string): Promise<void> {
  const output = outputPathFor(file, outputDirectory);
  if (output) fs.mkdirSync(path.dirname(output), { recursive: true });

  return new Promise((resolve) => {
    const args = [path.join(__dirname, "index.ts"), file];
    if (output) args.push(output);
    const child = spawn("tsx", args, {
      cwd: rootDir,
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
  const queued = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();
  let rendering = false;

  const processQueue = async () => {
    if (rendering) return;
    const next = [...queued].sort()[0];
    if (!next) return;

    rendering = true;
    queued.delete(next);
    await renderGraph(next, outputDirectory);
    rendering = false;
    void processQueue();
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
        void processQueue();
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

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startWatch(process.argv[2], process.argv[3]);
}
