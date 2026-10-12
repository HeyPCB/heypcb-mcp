// What `npm publish` would upload, checked before it does: exactly the
// bundle, its notices, the README, the licence and package.json — no source,
// no tests, no lockfile, no credentials. Run after `pnpm run build`.
import { execFileSync } from "node:child_process";

const out = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const files = out[0].files.map((f) => f.path).sort();
const want = ["LICENSE", "README.md", "dist/THIRD-PARTY-NOTICES.txt", "dist/cli.js", "package.json"];
if (JSON.stringify(files) !== JSON.stringify(want)) {
  console.error(`[check-pack] the package would hold:\n  ${files.join("\n  ")}\nexpected:\n  ${want.join("\n  ")}`);
  process.exit(1);
}
const cli = out[0].files.find((f) => f.path === "dist/cli.js");
if (!cli || cli.size < 100_000) {
  console.error("[check-pack] dist/cli.js is missing or too small to be the bundle; run `pnpm run build` first.");
  process.exit(1);
}
console.log(`[check-pack] ${out[0].name}@${out[0].version}: ${files.length} files, ${(out[0].size / 1024).toFixed(0)} KiB packed.`);
