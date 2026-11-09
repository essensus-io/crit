import { processContext } from "./context.ts";
import { runCli, VERSION } from "./main.ts";

const code = await runCli(process.argv.slice(2), processContext(VERSION));
if (process.argv[2] !== "mcp") process.exitCode = code;
