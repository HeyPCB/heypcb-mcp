// `node scripts/clean.mjs <dir>…`: remove build output folders (rm -rf that works on Windows too).
import { rmSync } from "node:fs";
for (const d of process.argv.slice(2)) rmSync(d, { recursive: true, force: true });
