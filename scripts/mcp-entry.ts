import { runMcpStdio } from "../packages/mcp/src/stdio.ts";

await runMcpStdio(process.argv[2]!, process.argv[3]!, "record");
