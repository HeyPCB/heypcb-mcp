/**
 * Run the fake HeyPCB host on its own, for a manual smoke run of the built
 * package under the MCP Inspector or an agent:
 *
 *   node .test-build/test/fake-main.js            # prints the URL, accepts any bearer
 *   HEYPCB_MCP_URL=<url>/mcp HEYPCB_API_KEY=hpcb_pk_x... node dist/cli.js
 */
import { startFakeHeypcb } from "./fake-heypcb.ts";

const fake = await startFakeHeypcb({});
process.stdout.write(`${fake.url}\n`);
const stop = () => {
  fake.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
