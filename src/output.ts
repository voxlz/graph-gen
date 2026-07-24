import path from "node:path";

export function resolveOutputPath(
  inputPath: string,
  cliOutputPath: string | undefined,
  configuredOutputPath: unknown,
): string {
  if (cliOutputPath) return cliOutputPath;

  const template =
    typeof configuredOutputPath === "string" && configuredOutputPath
      ? configuredOutputPath
      : "../graphs/{file}";
  const file = `${path.basename(inputPath, path.extname(inputPath))}.png`;
  const outputPath = template.replaceAll("{file}", file);

  return path.resolve(path.dirname(inputPath), outputPath);
}
