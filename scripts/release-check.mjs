// Should this commit publish? Compares package.json's version with npm's.
//
//   new version (or a package npm has never seen) -> publish=yes
//   the version npm already has                   -> publish=no  (exit 0: nothing to do)
//   a version OLDER than npm's latest             -> exit 1      (a mistake; npm would make it `latest`)
//   npm cannot be asked                           -> exit 1      (never guess)
//
// Writes `publish=yes|no` to $GITHUB_OUTPUT when it is set.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const mine = pkg.version;

function cmp(a, b) {
  const pa = a.split(/[.+-]/).slice(0, 3).map(Number);
  const pb = b.split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

let versions = [];
let latest = null;
try {
  const out = execFileSync("npm", ["view", pkg.name, "versions", "dist-tags.latest", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(out);
  versions = Array.isArray(parsed.versions) ? parsed.versions : [parsed.versions].filter(Boolean);
  latest = parsed["dist-tags.latest"] ?? null;
} catch (err) {
  const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  if (!/E404|404 Not Found|is not in this registry/.test(text)) {
    console.error(`[release-check] HOLD: npm could not be asked about ${pkg.name}:\n${text}`);
    process.exit(1);
  }
}

let publish;
if (versions.includes(mine)) {
  console.log(`[release-check] ${pkg.name}@${mine} is already on npm: nothing to publish.`);
  publish = "no";
} else if (latest && cmp(mine, latest) < 0) {
  console.error(`[release-check] ${pkg.name}@${mine} is older than npm's latest (${latest}). Bump package.json and src/version.ts past it.`);
  process.exit(1);
} else {
  console.log(`[release-check] ${pkg.name}@${mine} is new${latest ? ` (npm has ${latest})` : " (first publish)"}: publishing.`);
  publish = "yes";
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\nversion=${mine}\n`);
