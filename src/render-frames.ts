import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(__dirname, "..");
const input = path.join("demo", "usecases", "bookstore_uc1.ggn");
const outputDir = path.join(rootDir, "renders", "frames");
const frameEvery = "1";
const forceFrameEvery = "100";

for (const layout of ["constraint", "force"] as const) {
  const output = path.join(outputDir, `bookstore_uc1_${layout}.png`);
  const frameDirectory = path.join(outputDir, `bookstore_uc1_${layout}.frames`);
  fs.rmSync(frameDirectory, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  execFileSync("tsx", ["src/index.ts", input, output], {
    stdio: "inherit",
    cwd: rootDir,
    env: {
      ...process.env,
      GRAPHGEN_LAYOUT: layout,
      GRAPHGEN_DEBUG_FRAMES: frameEvery,
      GRAPHGEN_FORCE_DEBUG_FRAMES: forceFrameEvery,
    },
  });
}

console.log(`\nWrote constraint and force frame breakdowns under ${outputDir}`);
