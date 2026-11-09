import {
  FindingInput,
  FinishInput,
  type FindingInput as FindingInputT,
  type FinishInput as FinishInputT,
  jsonSchemas,
} from "@crit/schema";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type ScopeView = {
  label: string;
  files: { path: string; status: string; hunks?: { start: number; lines: number }[] }[];
  notes: string;
};

export type RuleView = { id: string; title: string; path: string; body: string };

export type ReportResult =
  | { accepted: true; id: string; warnings?: string[] }
  | { accepted: false; errors: string[] };

export interface SessionHandler {
  getScope(): Promise<ScopeView>;
  getRules(ids?: string[]): Promise<RuleView[]>;
  reportFinding(finding: FindingInputT): Promise<ReportResult>;
  finish(input: FinishInputT): Promise<{ ok: true }>;
}

export const TOOL_NAMES = [
  "get_scope",
  "get_rules",
  "report_finding",
  "report_findings",
  "finish",
] as const;

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.length ? i.path.join(".") : "(root)";
    if (i.code === "invalid_value" && "values" in i) {
      return `${path}: must be one of ${(i.values as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
    }
    return `${path}: ${i.message}`;
  });
}

const text = (s: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: s }],
  ...(isError ? { isError: true } : {}),
});

const GetRulesInput = z.object({ ids: z.array(z.string()).optional() }).strict();

function toolList() {
  const schemas = jsonSchemas();
  const strip = (s: Record<string, unknown>) => {
    const { $schema: _s, title: _t, ...rest } = s;
    return rest;
  };
  return [
    {
      name: "get_scope",
      description:
        "List the files (and, for diffs, the changed line ranges) you may report findings on. You can read any file in the repo for context, but only report on these.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_rules",
      description:
        'Get the full text of review rules that were listed by id but not included in the prompt. Pass ids like ["R7"], or nothing for all listed rules.',
      inputSchema: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "report_finding",
      description:
        "Report ONE review finding. Call once per issue. `anchor` must be an exact excerpt of the code at the range. `fix.patch` is a unified diff against the reviewed revision (paths a/<file> b/<file>). If the result lists errors, fix them and call again.",
      inputSchema: strip(schemas["finding.json"]!),
    },
    {
      name: "report_findings",
      description:
        "Report ALL your findings in one call (preferred: every call resends the conversation, so batching saves tokens). Each item is validated on its own: accepted ones are recorded, rejected ones are listed with their errors; resend only the rejected ones.",
      inputSchema: strip(schemas["findings.json"]!),
    },
    {
      name: "finish",
      description:
        "Call once when you are done with this shard: a short summary and what you did not cover.",
      inputSchema: strip(schemas["finish.json"]!),
    },
  ];
}

export function createCritMcpServer(
  handler: SessionHandler,
  info = { name: "crit", version: "0.0.0" },
): Server {
  const server = new Server(info, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const args = req.params.arguments ?? {};
    try {
      switch (req.params.name) {
        case "get_scope":
          return text(JSON.stringify(await handler.getScope(), null, 2));
        case "get_rules": {
          const parsed = GetRulesInput.safeParse(args);
          if (!parsed.success) return text(formatIssues(parsed.error).join("\n"), true);
          const rules = await handler.getRules(parsed.data.ids);
          if (rules.length === 0) return text("No matching rules.");
          return text(
            rules.map((r) => `## ${r.id} ${r.title} (${r.path})\n\n${r.body}`).join("\n\n"),
          );
        }
        case "report_finding": {
          const parsed = FindingInput.safeParse(args);
          if (!parsed.success) {
            return text(
              `Finding rejected. Fix these fields and call report_finding again:\n- ${formatIssues(parsed.error).join("\n- ")}`,
              true,
            );
          }
          const result = await handler.reportFinding(parsed.data);
          if (!result.accepted) {
            return text(
              `Finding rejected. Fix and call report_finding again:\n- ${result.errors.join("\n- ")}`,
              true,
            );
          }
          const warn = result.warnings?.length
            ? `\nWarnings:\n- ${result.warnings.join("\n- ")}`
            : "";
          return text(`Recorded finding ${result.id}.${warn}`);
        }
        case "report_findings": {
          const list = (args as { findings?: unknown }).findings;
          if (!Array.isArray(list) || list.length === 0)
            return text("findings: expected a non-empty array of findings", true);
          const lines: string[] = [];
          let accepted = 0;
          for (const [n, raw] of list.entries()) {
            const item = FindingInput.safeParse(raw);
            if (!item.success) {
              lines.push(`#${n + 1} rejected:\n  - ${formatIssues(item.error).join("\n  - ")}`);
              continue;
            }
            const result = await handler.reportFinding(item.data);
            if (!result.accepted) {
              lines.push(`#${n + 1} rejected:\n  - ${result.errors.join("\n  - ")}`);
              continue;
            }
            accepted++;
            const warn = result.warnings?.length
              ? ` (warnings: ${result.warnings.join("; ")})`
              : "";
            lines.push(`#${n + 1} recorded as ${result.id}${warn}`);
          }
          const rejected = list.length - accepted;
          return text(
            `${accepted} of ${list.length} findings recorded.${rejected ? ` Fix and resend the ${rejected} rejected:` : ""}\n${lines.join("\n")}`,
            accepted === 0,
          );
        }
        case "finish": {
          const parsed = FinishInput.safeParse(args);
          if (!parsed.success) return text(formatIssues(parsed.error).join("\n"), true);
          await handler.finish(parsed.data);
          return text("Shard finished. Stop now.");
        }
        default:
          return text(`Unknown tool ${req.params.name}. Tools: ${TOOL_NAMES.join(", ")}`, true);
      }
    } catch (err) {
      return text(`crit error: ${(err as Error).message}`, true);
    }
  });

  return server;
}
