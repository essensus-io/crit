import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectSession } from "./ipc.ts";
import { createCritMcpServer } from "./server.ts";

/**
 * Entry for `crit mcp --session <id>`: an MCP server on stdio that forwards
 * every tool call to the crit process hosting the session.
 */
export async function runMcpStdio(
  sessionsDir: string,
  sessionId: string,
  version: string,
): Promise<void> {
  const handler = await connectSession(sessionsDir, sessionId);
  const server = createCritMcpServer(handler, { name: "crit", version });
  const transport = new StdioServerTransport();
  transport.onclose = () => handler.close();
  await server.connect(transport);
}
