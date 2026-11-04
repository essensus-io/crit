import type { ReviewEvent, Shard } from "@crit/schema";
import { Box, Text } from "ink";
import { Footer, truncate } from "./components.tsx";

export type ProgressState = {
  header?: string;
  shards: Map<
    string,
    { shard: Shard; status: Shard["status"]; text?: string; findings: number; durationMs?: number }
  >;
  rules?: { attached: string[]; listed: number; conflicts: number };
  findings: number;
  verifying?: number;
  warnings: string[];
  done?: boolean;
  failed?: string;
};

export const emptyProgress = (): ProgressState => ({
  shards: new Map(),
  findings: 0,
  warnings: [],
});

/** Fold a review event into the progress state (pure, for tests). */
export function reduceProgress(p: ProgressState, e: ReviewEvent): ProgressState {
  const shards = new Map(p.shards);
  switch (e.type) {
    case "review-started":
      return { ...p, header: `${e.scope.label} · ${e.provider}${e.model ? ` (${e.model})` : ""}` };
    case "rules":
      return {
        ...p,
        rules: {
          attached: e.attached.map((r) => (r.section ? `${r.path} §${r.section}` : r.path)),
          listed: e.listed.length,
          conflicts: e.conflicts.length,
        },
      };
    case "plan":
      for (const s of e.shards) shards.set(s.id, { shard: s, status: "queued", findings: 0 });
      return {
        ...p,
        shards,
        header: `${p.header ?? ""} · ${e.shards.length} shard${e.shards.length === 1 ? "" : "s"}`,
      };
    case "shard-started": {
      const s = shards.get(e.shardId);
      if (s) shards.set(e.shardId, { ...s, status: "running" });
      return { ...p, shards };
    }
    case "shard-progress": {
      const s = shards.get(e.shardId);
      if (s) shards.set(e.shardId, { ...s, text: e.text });
      return { ...p, shards };
    }
    case "finding": {
      const s = e.finding.shardId ? shards.get(e.finding.shardId) : undefined;
      if (s && e.finding.shardId) shards.set(e.finding.shardId, { ...s, findings: s.findings + 1 });
      return { ...p, shards, findings: p.findings + 1 };
    }
    case "shard-done": {
      const s = shards.get(e.shard.id);
      if (s)
        shards.set(e.shard.id, {
          ...s,
          status: e.shard.status,
          ...(e.shard.durationMs ? { durationMs: e.shard.durationMs } : {}),
          ...(e.shard.error ? { text: e.shard.error } : {}),
        });
      return { ...p, shards };
    }
    case "verify-started":
      return { ...p, verifying: e.count };
    case "warning":
      return { ...p, warnings: [...p.warnings, e.message] };
    case "review-done":
      return { ...p, done: true };
    case "review-failed":
      return { ...p, done: true, failed: e.error };
    default:
      return p;
  }
}

const ICON: Record<Shard["status"], string> = {
  queued: "·",
  running: "◐",
  done: "✓",
  cached: "✓",
  failed: "✗",
  cancelled: "✗",
};
const secs = (ms?: number) =>
  ms === undefined
    ? ""
    : ms < 60_000
      ? `${Math.round(ms / 100) / 10}s`
      : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;

/** Run progress: shard rows, the rules line, findings so far (mockup 3). */
export function ProgressScreen({ progress, width }: { progress: ProgressState; width: number }) {
  const rows = [...progress.shards.values()];
  return (
    <Box flexDirection="column" width={width}>
      <Text bold> crit review · {progress.header ?? "starting…"}</Text>
      <Text> </Text>
      {rows.map((r) => (
        <Text key={r.shard.id}>
          {" "}
          <Text
            {...(r.status === "failed"
              ? { color: "red" }
              : r.status === "done" || r.status === "cached"
                ? { color: "green" }
                : {})}
          >
            {ICON[r.status]}
          </Text>{" "}
          {truncate(r.shard.label, 18).padEnd(18)}{" "}
          {truncate(r.shard.lenses.join(", "), 28).padEnd(28)}{" "}
          {r.status === "queued" ? (
            <Text dimColor>queued</Text>
          ) : r.status === "running" ? (
            <Text dimColor>{truncate(r.text ?? "starting…", Math.max(10, width - 56))}</Text>
          ) : r.status === "failed" ? (
            <Text color="red">{truncate(r.text ?? "failed", Math.max(10, width - 56))}</Text>
          ) : (
            <Text>
              {r.findings} finding{r.findings === 1 ? "" : "s"}
              <Text dimColor> {r.status === "cached" ? "cached" : secs(r.durationMs)}</Text>
            </Text>
          )}
        </Text>
      ))}
      <Text> </Text>
      {progress.rules ? (
        <Text>
          {` ${"Rules".padEnd(7)}${progress.rules.attached.length} attached`}
          {progress.rules.attached.length
            ? `: ${truncate(progress.rules.attached.join(", "), Math.max(20, width - 30))}`
            : ""}
          {`\n ${"".padEnd(7)}${progress.rules.listed} listed only`}
          {progress.rules.conflicts
            ? ` · ${progress.rules.conflicts} conflict${progress.rules.conflicts === 1 ? "" : "s"} (see crit rules)`
            : ""}
        </Text>
      ) : null}
      {progress.verifying ? (
        <Text color="cyan"> ◐ Verifying {progress.verifying} findings with the skeptic…</Text>
      ) : null}
      {progress.warnings.slice(-3).map((w, i) => (
        <Text key={i} color="yellow">
          {" "}
          ! {truncate(w, width - 4)}
        </Text>
      ))}
      {progress.failed ? <Text color="red"> ✗ {progress.failed}</Text> : null}
      <Text> </Text>
      <Text> {progress.findings} findings so far</Text>
      <Footer
        width={width}
        keys={[
          ["q", "stop"],
          ["enter", "open findings so far"],
        ]}
      />
    </Box>
  );
}
