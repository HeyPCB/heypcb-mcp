// Build dist/cli.js: ONE file, every dependency bundled at the version
// pnpm-lock.yaml pins, so `npx -y @heypcb/mcp` installs nothing else — no
// dependency resolved fresh on the user's computer, nothing native, a fast
// first start. The notices of every bundled package go beside it in
// dist/THIRD-PARTY-NOTICES.txt (their licences ask for that).
import { build } from "esbuild";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // A bundled CommonJS module's require() of a Node built-in needs a real require in ESM.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __heypcbCreateRequire } from 'node:module';\nconst require = __heypcbCreateRequire(import.meta.url);",
  },
  legalComments: "eof",
  metafile: true,
  sourcemap: false,
  minify: false,
  logLevel: "warning",
});
chmodSync(path.join(dist, "cli.js"), 0o755);

// Which packages went into the bundle, and their licences.
const pkgs = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const norm = input.split(path.sep).join("/");
  const i = norm.lastIndexOf("node_modules/");
  if (i < 0) continue;
  const rest = norm.slice(i + "node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  const dir = path.join(root, norm.slice(0, i + "node_modules/".length) + name);
  if (!pkgs.has(dir)) pkgs.set(dir, name);
}
const sections = [];
for (const [dir, name] of [...pkgs.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1))) {
  const meta = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const licenceFile = existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f)) : undefined;
  if (!licenceFile) throw new Error(`${name}@${meta.version} has no licence file; check its terms before bundling it.`);
  const text = readFileSync(path.join(dir, licenceFile), "utf8").trim();
  sections.push(`${name}@${meta.version} (${typeof meta.license === "string" ? meta.license : "see below"})\n${"-".repeat(72)}\n${text}\n`);
}
writeFileSync(
  path.join(dist, "THIRD-PARTY-NOTICES.txt"),
  `@heypcb/mcp bundles the following packages into dist/cli.js.\n\n${sections.join("\n")}`
);
const size = readFileSync(path.join(dist, "cli.js")).length;
console.log(`dist/cli.js ${(size / 1024).toFixed(0)} KiB, ${pkgs.size} bundled packages`);
