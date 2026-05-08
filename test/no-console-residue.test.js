const fs = require("fs");
const path = require("path");

let failed = 0;
function assert(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`  FAIL ${label}`); failed++; }
}

const files = ["index.js", "lib/store.js", "lib/detection.js"];

for (const rel of files) {
  const abs = path.join(__dirname, "..", rel);
  let src = fs.readFileSync(abs, "utf8");
  src = src.replace(/\/\*[\s\S]*?\*\//g, "");
  src = src.replace(/^[ \t]*\/\/.*$/gm, "");
  const m = src.match(/\bconsole\.(log|warn|error|info|debug)\s*\(/);
  assert(`${rel}: no console.* residue`, m === null);
  if (m) console.error(`    found: ${m[0]} at index ${m.index}`);
}

if (failed > 0) { console.error(`\n${failed} failed.\n`); process.exit(1); }
console.log("\nNo console.* residue.\n");
