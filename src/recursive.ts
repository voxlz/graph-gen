import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { rendererCommand } from "./bundle";
import { findGraphFiles } from "./watch";

export function renderRecursively(targetPath = process.cwd()): number {
  const target = path.resolve(targetPath);
  let files: string[];
  try {
    if (!fs.statSync(target).isDirectory()) {
      console.error(`[recursive] expected a directory: ${target}`);
      return 1;
    }
    files = findGraphFiles(target, []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[recursive] ${message}`);
    return 1;
  }

  if (files.length === 0) {
    console.log(`[recursive] no .ggn files found under ${target}`);
    return 0;
  }

  const renderer = rendererCommand();
  let failed = 0;
  for (const file of files) {
    const result = spawnSync(renderer.command, [...renderer.args, file], {
      stdio: "inherit",
    });
    if (result.error || result.status !== 0) {
      failed++;
      const reason =
        result.error?.message ??
        (result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
      console.error(`[recursive] failed to render ${file}: ${reason}`);
    }
  }
  console.log(
    `[recursive] rendered ${files.length - failed} of ${files.length} .ggn file(s); ${failed} failed`,
  );
  return failed > 0 ? 1 : 0;
}
