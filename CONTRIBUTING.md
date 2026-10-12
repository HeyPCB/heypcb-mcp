# Contributing to @heypcb/mcp

This repository is published from HeyPCB's monorepo: each release is
mirrored here as one commit ("Release <version> (monorepo <sha>)"), and
this repository's CI publishes it to npm with provenance.

- **Issues**: open them here — bugs, questions, agents or platforms that do
  not work, ideas.
- **Pull requests** are welcome. CI runs the tests on every pull request.
  A change that is accepted is ported upstream into the monorepo and
  arrives here with the next release, so a pull request is closed with a
  note rather than merged here: each release commit replaces this
  repository's tree with the monorepo's.
- **Security problems**: please do not open a public issue; see
  [SECURITY.md](SECURITY.md).

## Working on it

Node.js 18 or newer and pnpm 9 (`corepack enable` gives you the version
`package.json` names).

```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm run typecheck
pnpm run test          # node --test against a fake HeyPCB host
pnpm run build         # dist/cli.js, one bundled file
pnpm run test:smoke    # the built file over stdio
```

The package holds no design logic: it passes HeyPCB's remote MCP tools
through unchanged and adds the two tools that need your files
(`upload_kicad_project`, `save_export`). A change to what a remote tool
does belongs to HeyPCB's server, not here — an issue is the way to ask
for one.

By contributing you agree that your contribution is licensed under this
repository's MIT licence.
