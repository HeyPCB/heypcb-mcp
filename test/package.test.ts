import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { VERSION } from "../src/version.ts";
import { LOCAL_TOOLS } from "../src/local-tools.ts";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

test("the version in the code is the package's", () => {
  assert.equal(VERSION, pkg.version);
});

test("the package is a self-contained bin: no runtime dependency to resolve on the user's computer", () => {
  assert.equal(pkg.name, "@heypcb/mcp");
  assert.deepEqual(pkg.bin, { "heypcb-mcp": "dist/cli.js" });
  assert.equal(pkg.dependencies, undefined, "everything is bundled into dist/cli.js at the locked versions");
  assert.equal(pkg.engines.node, ">=18");
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.files.includes("dist/cli.js") && pkg.files.includes("LICENSE") && pkg.files.includes("README.md"));
  for (const [name, version] of Object.entries<string>(pkg.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
});

// Names that would point a reader of the public source at the private monorepo or a person: its
// repository and owner, and its internal paths. Built from parts so this file does not match itself.
const PRIVATE_NAMES = new RegExp(
  [
    ["Justin", "3134"].join(""),
    ["HeyPCB", "HeyPCB(?![\\w-])"].join("/"),
    ["docs", "rules"].join("/"),
    ["apps", "web"].join("/"),
    ["runner", ""].join("/"),
    ["kicad", "_tools"].join(""),
    ["clients", "(?:mcp|kicad)"].join("/"),
  ].join("|"),
  "i",
);

// The source is public at HeyPCB/heypcb-mcp, the repository whose CI publishes the package with
// provenance (npm checks that the provenance statement's repository is package.json's). 0.1.0
// linked a private repository under a personal account instead: a dead link on npm's page.
const PUBLIC_REPO = "HeyPCB/heypcb-mcp";

test("package.json links the public source repository, and only it", () => {
  assert.deepEqual(pkg.repository, { type: "git", url: `git+https://github.com/${PUBLIC_REPO}.git` });
  assert.deepEqual(pkg.bugs, { url: `https://github.com/${PUBLIC_REPO}/issues` });
  assert.equal(pkg.homepage, "https://heypcb.ai/mcp");
  const text = JSON.stringify(pkg);
  const repos = [...text.matchAll(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[/"#?]|$)/gi)].map((m) => `${m[1]}/${m[2]}`);
  assert.deepEqual([...new Set(repos)], [PUBLIC_REPO], "every GitHub link is the public repository");
  assert.doesNotMatch(text, PRIVATE_NAMES);
});

function* textFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".test-build", ".git"].includes(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* textFiles(p);
    else if (!/\.(?:tgz|png|jpe?g|gif|ico|zip)$/i.test(name)) yield p;
  }
}

test("nothing in the package's source names the private monorepo, its paths or a personal account", () => {
  const hits: string[] = [];
  let files = 0;
  for (const file of textFiles(root)) {
    files++;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (PRIVATE_NAMES.test(line)) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.ok(files > 20, `scanned ${files} files: a scan of nothing is not a clean scan`);
  assert.deepEqual(hits, []);
});

test("the public repository's CI tests every pull request and is the one publisher, with provenance", () => {
  // In this package's source it waits in mirror/, which the release script moves to the root.
  const where = [path.join(root, "mirror", ".github", "workflows", "ci.yml"), path.join(root, ".github", "workflows", "ci.yml")].find((p) => existsSync(p));
  assert.ok(where, "the CI workflow is in mirror/ or at the root");
  const ci = readFileSync(where, "utf8");
  assert.match(ci, /\n  pull_request:\n/);
  assert.match(ci, /npm publish --access public --provenance --ignore-scripts/);
  assert.match(ci, /id-token: write/);
  assert.match(ci, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(ci, /node scripts\/release-check\.mjs/);
  assert.doesNotMatch(ci, /\.\.\//, "nothing outside the package: the public repository holds only it");
  for (const doc of ["CONTRIBUTING.md", "SECURITY.md"]) {
    assert.ok(existsSync(path.join(root, "mirror", doc)) || existsSync(path.join(root, doc)), doc);
  }
});

test("the README names every local tool and the one-line installs", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  for (const t of LOCAL_TOOLS) assert.ok(readme.includes(t.name), t.name);
  assert.ok(readme.includes("claude mcp add --transport http heypcb https://api.heypcb.ai/mcp"));
  assert.ok(readme.includes("claude mcp add heypcb -- npx -y @heypcb/mcp"));
});
