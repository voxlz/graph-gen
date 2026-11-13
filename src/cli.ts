// cli.ts — informational command-line flags (--help, --version).

import fs from "node:fs";
import path from "node:path";

// package.json sits one level above both src/ and the dist/ bundle.
export function packageVersion(): string {
  try {
    const file = path.join(__dirname, "..", "package.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function helpText(version: string): string {
  return `graphgen ${version} — render .ggn graph files to PNG

Usage:
  graphgen <input.ggn|input.json> [output.png] [style.jsonc]
  graphgen --watch [path] [output-directory]
  graphgen --help | --version

Arguments:
  input         Graph to render (.ggn DSL or parsed .json).
  output        PNG to write. Default: the graph's outputPath setting, else
                ../graphs/<name>.png relative to the input file.
  style         Global style file. Default: style.jsonc next to graphgen.

Options:
  -w, --watch    Watch a .ggn file or folder (default: current folder) and
                 re-render graphs, and graphs importing them, on save. PNGs go
                 to output-directory, else each graph's usual output path.
  -h, --help     Show this help and exit.
  -v, --version  Print the version and exit.

Environment:
  GRAPHGEN_LAYOUT            Layout engine: curved (default), orthogonal,
                             constraint, cola or force.
  GRAPHGEN_CONSTRAINT_HINTS  Set to 1 to report rules that block a smaller
                             layout.
  GRAPHGEN_DUMP              Write node positions and edge paths as JSON to
                             this file.
`;
}

export function isWatchFlag(arg: string | undefined): boolean {
  return arg === "-w" || arg === "--watch";
}

// Result for an informational flag, or null when the arguments are a normal
// render. Unknown options are an error instead of being read as a file name.
export function handleInfoFlags(
  args: string[],
  version = packageVersion(),
): { output: string; exitCode: number; stream: "stdout" | "stderr" } | null {
  const first = args[0];
  if (first === "-h" || first === "--help") {
    return { output: helpText(version), exitCode: 0, stream: "stdout" };
  }
  if (first === "-v" || first === "--version") {
    return { output: `${version}\n`, exitCode: 0, stream: "stdout" };
  }
  if (first?.startsWith("-") && first !== "-" && !isWatchFlag(first)) {
    return {
      output: `graphgen: unknown option ${first}\n\n${helpText(version)}`,
      exitCode: 2,
      stream: "stderr",
    };
  }
  return null;
}
