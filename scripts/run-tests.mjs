// Run the compiled tests with node's own runner, one file list for every
// Node version (a directory or glob argument means different things on 18,
// 20 and 22). `node scripts/run-tests.mjs smoke` runs only the smoke test,
// which needs dist/ built first; `… kicad-cli` only the kicad-cli tests.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, ".test-build", "test");
const only = process.argv[2];
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => (only ? f.startsWith(only) : !f.startsWith("smoke")))
  .sort()
  .map((f) => path.join(dir, f));
if (!files.length) {
  console.error(`no compiled tests found in ${dir}`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
