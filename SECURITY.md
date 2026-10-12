# Security

Please report a security problem in `@heypcb/mcp` — or in HeyPCB's API or
MCP server that it talks to — privately, by email to **inky@heypcb.ai**
(the contact in https://heypcb.ai/.well-known/security.txt), not in a public
issue or pull request.

Useful to include: the package version (`npx @heypcb/mcp --version` or the
version in `package.json`), your operating system and Node.js version, the
agent that runs the server (Claude Code, Codex, Cursor, …), and the steps
that show the problem. Never send a real sign-in or API key: what this
package stores in `credentials.json`, or a `hpcb_pk_…` key, can be revoked
in heypcb.ai → Settings → Devices & API keys, and should be if you think it
leaked.

Only the latest published version is supported; a fix ships as a new
version.
