import { z } from "zod";
import { ConfigFile } from "./config.ts";
import { FindingInput, FindingsInput, FinishInput } from "./finding.ts";
import { ProvidersFile } from "./provider.ts";

/** JSON Schemas published for editors (config, providers) and agents (MCP tool input, JSON fallback). */
export function jsonSchemas(): Record<string, Record<string, unknown>> {
  const gen = (schema: z.ZodType, title: string) => ({
    title,
    ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
  });
  return {
    "config.json": gen(ConfigFile, "crit config (.crit/config.json, ~/.config/crit/config.json)"),
    "providers.json": gen(ProvidersFile, "crit provider profiles (~/.config/crit/providers.json)"),
    "finding.json": gen(FindingInput, "crit finding (report_finding input)"),
    "findings.json": gen(FindingsInput, "crit findings (report_findings input)"),
    "finish.json": gen(FinishInput, "crit finish (finish input)"),
    "review-output.json": gen(
      z.object({ findings: z.array(FindingInput), summary: z.string() }),
      "crit review output (JSON fallback when MCP is unavailable)",
    ),
  };
}

export function stringifySchema(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
