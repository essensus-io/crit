import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigFile,
  DEFAULT_CONFIG,
  FindingInput,
  ProvidersFile,
  ReviewExport,
  ScopeSpec,
  UUID_V7,
  jsonSchemas,
  newId,
  resolveConfig,
  shortId,
  stringifySchema,
} from "../src/index.ts";

const validFinding = {
  file: "src/api/payments.ts",
  range: { start: 88, end: 96 },
  anchor: "await provider.refund(order.chargeId, amount);",
  severity: "critical",
  category: "correctness",
  title: "Refund amount not validated",
  explanation: "refund() takes any amount from the request body.",
  confidence: 0.92,
};

describe("FindingInput", () => {
  it("accepts a valid finding and defaults ruleIds", () => {
    const f = FindingInput.parse(validFinding);
    expect(f.ruleIds).toEqual([]);
  });

  it("rejects an inverted range, long title and out-of-range confidence", () => {
    const r = FindingInput.safeParse({
      ...validFinding,
      range: { start: 10, end: 5 },
      title: "x".repeat(101),
      confidence: 1.5,
    });
    expect(r.success).toBe(false);
    const paths = r.error!.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["range", "title", "confidence"]));
  });

  it("rejects unknown severity", () => {
    expect(FindingInput.safeParse({ ...validFinding, severity: "blocker" }).success).toBe(false);
  });
});

describe("ProvidersFile", () => {
  const claude = { name: "claude", type: "claude-code", command: "claude", model: "opus" };

  it("fills defaults", () => {
    const f = ProvidersFile.parse({ providers: [claude] });
    expect(f.default).toBeNull();
    expect(f.roles).toEqual({});
    expect(f.providers[0]!.enabled).toBe(true);
  });

  it("rejects duplicate names, unknown default and unknown role targets", () => {
    const r = ProvidersFile.safeParse({
      default: "nope",
      providers: [claude, claude],
      roles: { skeptic: "ghost" },
    });
    expect(r.success).toBe(false);
    const msgs = r.error!.issues.map((i) => i.message).join("\n");
    expect(msgs).toMatch(/duplicate provider name "claude"/);
    expect(msgs).toMatch(/default "nope" is not a provider/);
    expect(msgs).toMatch(/role skeptic points at unknown provider "ghost"/);
  });

  it("rejects unsafe names", () => {
    expect(ProvidersFile.safeParse({ providers: [{ ...claude, name: "a b" }] }).success).toBe(
      false,
    );
  });
});

describe("ConfigFile and resolveConfig", () => {
  it("parses the documented example", () => {
    const parsed = ConfigFile.parse({
      $schema: "https://unpkg.com/crit/schema/config.json",
      provider: "claude",
      base: "main",
      lenses: ["correctness", "security", "performance", "maintainability"],
      severityThreshold: "minor",
      rules: {
        sources: ["project", "global", "user"],
        include: [".crit/rules/**/*.md", "github:acme/review-rules#v2"],
        exclude: ["CLAUDE.md#Commit messages"],
      },
      ignore: ["**/*.generated.ts", "dist/**"],
      review: { allowedCommands: ["pnpm typecheck", "pnpm test"] },
      verify: { commands: ["pnpm typecheck", "pnpm test --changed"] },
      concurrency: 3,
      budget: { maxShards: 40, maxMinutes: 20 },
    });
    expect(parsed.provider).toBe("claude");
  });

  it("rejects unknown keys", () => {
    expect(ConfigFile.safeParse({ lense: ["security"] }).success).toBe(false);
  });

  it("returns defaults with no layers", () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("later layers win; ignore and rule include/exclude accumulate", () => {
    const user = ConfigFile.parse({
      concurrency: 2,
      ignore: ["a/**"],
      lenses: ["security"],
      rules: { exclude: ["X.md"], include: ["i.md"], sources: ["user"], budgetTokens: 100 },
      review: { allowedCommands: ["x"], timeoutMinutes: 3 },
      verify: { commands: ["v"] },
      budget: { maxShards: 2, maxMinutes: 1 },
      shardTokens: 10,
      severityThreshold: "major",
      base: "dev",
      provider: "me",
    });
    const project = ConfigFile.parse({
      concurrency: 5,
      ignore: ["a/**", "b/**"],
      rules: { exclude: ["Y.md"] },
    });
    const flags = ConfigFile.parse({ lenses: ["performance"] });
    const r = resolveConfig(user, project, undefined, flags);
    expect(r.concurrency).toBe(5);
    expect(r.ignore).toEqual(["a/**", "b/**"]);
    expect(r.lenses).toEqual(["performance"]);
    expect(r.rules).toEqual({
      sources: ["user"],
      include: ["i.md"],
      exclude: ["X.md", "Y.md"],
      budgetTokens: 100,
    });
    expect(r.review).toEqual({ allowedCommands: ["x"], timeoutMinutes: 3 });
    expect(r.verify.commands).toEqual(["v"]);
    expect(r.budget).toEqual({
      maxShards: 2,
      maxMinutes: 1,
      confirmTokens: 500_000,
      maxTokens: 2_000_000,
    });
    expect(r.depth).toBe("standard");
    expect(r.maxFileTokens).toBe(20_000);
    const tuned = resolveConfig(
      ConfigFile.parse({
        depth: "deep",
        maxFileTokens: 5000,
        budget: { confirmTokens: 1, maxTokens: 2 },
      }),
    );
    expect([
      tuned.depth,
      tuned.maxFileTokens,
      tuned.budget.confirmTokens,
      tuned.budget.maxTokens,
    ]).toEqual(["deep", 5000, 1, 2]);
    expect(ConfigFile.safeParse({ depth: "extreme" }).success).toBe(false);
    expect(r.shardTokens).toBe(10);
    expect(r.severityThreshold).toBe("major");
    expect(r.base).toBe("dev");
    expect(r.provider).toBe("me");
    // defaults are not mutated
    expect(DEFAULT_CONFIG.ignore).toEqual([]);
  });
});

describe("ScopeSpec", () => {
  it("defaults diff to false for path scopes", () => {
    expect(ScopeSpec.parse({ kind: "paths", paths: ["src"] })).toEqual({
      kind: "paths",
      paths: ["src"],
      diff: false,
    });
  });
  it("requires at least one path", () => {
    expect(ScopeSpec.safeParse({ kind: "paths", paths: [] }).success).toBe(false);
  });
});

describe("ids", () => {
  it("makes UUIDv7 ids that sort in creation order", () => {
    const ids = Array.from({ length: 200 }, () => newId());
    for (const id of ids) expect(id).toMatch(UUID_V7);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("encodes the timestamp in the first 48 bits", () => {
    const t = Date.UTC(2030, 0, 1);
    const id = newId(t);
    expect(parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(t);
  });

  it("keeps ordering when the clock goes backwards", () => {
    const a = newId(Date.UTC(2031, 0, 1));
    const b = newId(Date.UTC(2020, 0, 1));
    expect(b > a).toBe(true);
  });

  it("shortId is 4 hex chars", () => {
    expect(shortId(newId())).toMatch(/^[0-9a-f]{4}$/);
  });
});

describe("ReviewExport", () => {
  it("requires the format marker and version", () => {
    expect(ReviewExport.safeParse({ format: "other", version: 1 }).success).toBe(false);
  });
});

describe("generated JSON Schemas", () => {
  it("are up to date (run `pnpm --filter @crit/schema generate`)", () => {
    for (const [name, schema] of Object.entries(jsonSchemas())) {
      const onDisk = readFileSync(join(import.meta.dirname, "..", "json", name), "utf8");
      expect({ name, json: onDisk }).toEqual({ name, json: stringifySchema(schema) });
    }
  });

  it("finding schema requires the core fields", () => {
    const s = jsonSchemas()["finding.json"] as { required: string[] };
    expect(s.required).toEqual(
      expect.arrayContaining([
        "file",
        "range",
        "anchor",
        "severity",
        "category",
        "title",
        "explanation",
        "confidence",
      ]),
    );
  });
});
