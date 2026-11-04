import { runMcpStdio } from "../src/stdio.ts";

await runMcpStdio(process.argv[2]!, process.argv[3]!, "test");
