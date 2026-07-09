// generate.js
// Render one or more graphs from explicit input/output path pairs.
//
// Usage:
//   node generate.js <input1> <output1> [<input2> <output2> ...]
//
// Example:
//   node generate.js demo/usecases/bookstore_uc1.txt out/bookstore_uc1.png \
//                     demo/scopes/weather_scope.txt  out/weather_scope.png
//
// Each pair is rendered by index.js. Missing input files or an odd number of
// arguments are reported and cause a non-zero exit.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);

if (args.length === 0 || args.length % 2 !== 0) {
  console.error(
    "Usage: node generate.js <input1> <output1> [<input2> <output2> ...]",
  );
  process.exit(1);
}

const pairs = [];
for (let i = 0; i < args.length; i += 2) {
  pairs.push({ input: args[i], output: args[i + 1] });
}

let failures = 0;
for (const { input, output } of pairs) {
  if (!fs.existsSync(input)) {
    console.error(`[skip] input not found: ${input}`);
    failures++;
    continue;
  }
  const outDir = path.dirname(output);
  if (outDir && outDir !== ".") fs.mkdirSync(outDir, { recursive: true });
  try {
    execFileSync("node", [path.join(__dirname, "index.js"), input, output], {
      stdio: "inherit",
      cwd: __dirname,
    });
  } catch (err) {
    console.error(`[fail] ${input} -> ${output}: ${err.message}`);
    failures++;
  }
}

const ok = pairs.length - failures;
console.log(`\nGenerated ${ok}/${pairs.length} image(s).`);
if (failures > 0) process.exit(1);
