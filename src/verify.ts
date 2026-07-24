// verify.ts — programmatic checks on a layout dump produced via GRAPHGEN_DUMP.
// Usage: tsx src/verify.ts <dump.json> [rulesFile.txt-or-json]
//
// Checks:
//   1. all node positions are finite
//   2. no two nodes overlap (respecting rectangle extents)
//   3. every explicit ordering constraint in the source is satisfied
//   4. every node stays within its boundary's rendered rect
//
// Exit code is non-zero if any check fails.

import fs from "node:fs";
import path from "node:path";
import { parseGraphText, stripComments } from "./parse";

const dumpPath = process.argv[2];
const rulesPath = process.argv[3];
const dump: { nodes: any[]; groups: any[]; meta?: any } = JSON.parse(
  fs.readFileSync(dumpPath, "utf8"),
);

const byId = Object.fromEntries(dump.nodes.map((n) => [n.id, n]));
const groupById = Object.fromEntries(dump.groups.map((g) => [g.id, g]));

let failures = 0;
function check(ok: boolean, msg: string) {
  if (ok) {
    console.log(`  ok   ${msg}`);
  } else {
    console.error(`  FAIL ${msg}`);
    failures++;
  }
}

// 1. finite positions
console.log("[finite positions]");
for (const n of dump.nodes) {
  check(
    Number.isFinite(n.x) && Number.isFinite(n.y),
    `${n.id} has finite position (${n.x?.toFixed?.(1)}, ${n.y?.toFixed?.(1)})`,
  );
}

// 2. minimum gap between nodes (no overlaps AND at least nodeGap clearance)
console.log("[minimum node gap]");
const EPS = 1.0;
const nodeGap = dump.meta?.nodeGap ?? 0;
let tooClose = 0;
for (let i = 0; i < dump.nodes.length; i++) {
  for (let j = i + 1; j < dump.nodes.length; j++) {
    const a = dump.nodes[i];
    const b = dump.nodes[j];
    const gapX = Math.abs(a.x - b.x) - (a.width / 2 + b.width / 2);
    const gapY = Math.abs(a.y - b.y) - (a.height / 2 + b.height / 2);
    // separated on at least one axis by >= nodeGap
    const clearance = Math.max(gapX, gapY);
    if (clearance < nodeGap - EPS) {
      tooClose++;
      console.error(
        `  FAIL ${a.id} / ${b.id} clearance ${clearance.toFixed(1)} < gap ${nodeGap}`,
      );
    }
  }
}
check(
  tooClose === 0,
  `all node pairs keep >= ${nodeGap}px clearance (violations ${tooClose})`,
);

// 3. explicit ordering constraints
if (rulesPath) {
  console.log("[explicit constraints]");
  const raw = fs.readFileSync(rulesPath, "utf8");
  let constraints;
  if (path.extname(rulesPath).toLowerCase() === ".txt") {
    constraints = parseGraphText(raw).spec.constraints;
  } else {
    constraints =
      JSON.parse(stripComments(raw).replace(/,(\s*[}\]])/g, "$1"))
        .constraints || [];
  }
  // resolve a constraint id to a centre point: a node, or a boundary (group).
  const center = (id: string) => {
    const n = byId[id];
    if (n) return { id, x: n.x, y: n.y };
    const g = groupById[id];
    if (g && g.rect)
      return {
        id,
        x: (g.rect.minX + g.rect.maxX) / 2,
        y: (g.rect.minY + g.rect.maxY) / 2,
      };
    return null;
  };
  for (const rule of constraints) {
    const A = center(rule.a ?? rule.left ?? rule.top);
    const B = center(rule.b ?? rule.right ?? rule.bottom);
    if (!A || !B) continue; // dangling refs are reported by the renderer
    const t = rule.type;
    const aLeftOfB = A.x < B.x - EPS;
    const aRightOfB = A.x > B.x + EPS;
    const aAboveB = A.y < B.y - EPS;
    const aBelowB = A.y > B.y + EPS;
    const desc = `${A.id} ${t} ${B.id}`;
    switch (t) {
      case "left":
        check(aLeftOfB, desc);
        break;
      case "right":
        check(aRightOfB, desc);
        break;
      case "top":
        check(aAboveB, desc);
        break;
      case "bottom":
        check(aBelowB, desc);
        break;
      case "topleft":
        check(aAboveB && aLeftOfB, desc);
        break;
      case "topright":
        check(aAboveB && aRightOfB, desc);
        break;
      case "bottomleft":
        check(aBelowB && aLeftOfB, desc);
        break;
      case "bottomright":
        check(aBelowB && aRightOfB, desc);
        break;
      case "near":
        break; // soft constraint, not asserted
      default:
        break;
    }
  }
}

// 4. containment within boundary rects
console.log("[boundary containment]");
for (const n of dump.nodes) {
  if (!n.parent) continue;
  const g = groupById[n.parent];
  if (!g || !g.rect) continue;
  const inside =
    n.x - n.width / 2 >= g.rect.minX - EPS &&
    n.x + n.width / 2 <= g.rect.maxX + EPS &&
    n.y - n.height / 2 >= g.rect.minY - EPS &&
    n.y + n.height / 2 <= g.rect.maxY + EPS;
  check(inside, `${n.id} is inside boundary ${n.parent}`);
}

// 5. clear inside/outside: a node that does NOT belong to a boundary (directly
//    or via nesting) must sit fully outside that boundary's rect, never
//    straddling its border.
console.log("[boundary separation]");
function belongsTo(node: any, boundaryId: string) {
  let cur = node.parent;
  while (cur) {
    if (cur === boundaryId) return true;
    cur = groupById[cur]?.parent ?? null;
  }
  return false;
}
for (const g of dump.groups) {
  if (!g.rect) continue;
  for (const n of dump.nodes) {
    if (belongsTo(n, g.id)) continue; // members are meant to be inside
    const nMinX = n.x - n.width / 2;
    const nMaxX = n.x + n.width / 2;
    const nMinY = n.y - n.height / 2;
    const nMaxY = n.y + n.height / 2;
    const fullyOutside =
      nMaxX <= g.rect.minX + EPS ||
      nMinX >= g.rect.maxX - EPS ||
      nMaxY <= g.rect.minY + EPS ||
      nMinY >= g.rect.maxY - EPS;
    check(fullyOutside, `${n.id} is clear of boundary ${g.id}`);
  }
}

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("All checks passed.");
}
