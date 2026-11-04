// Stand-in for `crit mcp --session <id>` used before the CLI is built
// (fixture recording). Usage: node scripts/mcp-entry.ts <sessionsDir> <sessionId>
import { runMcpStdio } from "../packages/mcp/src/stdio.ts";

await runMcpStdio(process.argv[2]!, process.argv[3]!, "record");
