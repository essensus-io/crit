import { formatTokens, type Shard } from "@crit/schema";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { Footer } from "../../shared/ui/index.ts";
import { T, type Tone } from "../../shared/lib/index.ts";
import { Bar, Panel, Spinner, StatusBar, Viewport } from "../../shared/ui/index.ts";
import { truncate } from "../../shared/lib/index.ts";
import { useTick } from "../../shared/hooks/index.ts";
import { type ProgressState, type Selection } from "../../features/run-progress/index.ts";

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);

const STATUS_TONE: Record<Shard["status"], Tone> = {
  queued: "gray",
  running: "orange",
  done: "mint",
  cached: "lav",
  failed: "red",
  cancelled: "red",
};
type FlowProps = { active: boolean; tick: number };

const Flow = ({ active, tick }: FlowProps) => {
  const cells = ["╌", "╌", "╌", "╌", "▶"];
  const dot = active ? tick % 4 : -1;
  return (
    <Box width={5} height={4} alignItems="center" paddingTop={1}>
      <Text color={active ? T.orange : T.gray}>
        {cells.map((c, i) => (i === dot ? "•" : c)).join("")}
      </Text>
    </Box>
  );
};
type NodeProps = {
  title: string;
  state: "idle" | "active" | "done";
  width: number;
  lines: [string, string];
};

const Node = ({ title, state, width, lines }: NodeProps) => {
  const tone: Tone = state === "active" ? "orange" : state === "done" ? "mint" : "gray";
  return (
    <Panel title={title} tone={tone} width={width} height={4}>
      <Text wrap="truncate">{lines[0]}</Text>
      <Text wrap="truncate" dimColor>
        {lines[1]}
      </Text>
    </Panel>
  );
};
type ProgressViewProps = {
  progress: ProgressState;
  width: number;
  height: number;
  selection?: Selection;
  depth?: string;
  effort?: string | null;
  notice?: string;
};

export const ProgressView = ({
  progress,
  width,
  height,
  selection = {},
  depth = "standard",
  effort = null,
  notice,
}: ProgressViewProps) => {
  const running = !progress.done;
  const tick = useTick(300, running);
  const rows = [...progress.shards.values()];
  const doneCount = rows.filter((r) =>
    ["done", "cached", "failed", "cancelled"].includes(r.status),
  ).length;
  const phase = progress.done
    ? "done"
    : progress.verifying
      ? "verify"
      : rows.some((r) => r.status === "running")
        ? "review"
        : "plan";
  const showFlow = height >= 22;
  const provider = selection.provider ?? progress.provider ?? "";
  const model = selection.model !== undefined ? selection.model : progress.model;
  const eff = selection.effort !== undefined ? selection.effort : effort;

  const fixed = 1 + (showFlow ? 4 : 0) + 1 + 1 + 1 + 2;
  const cols = width >= 100 ? 3 : 2;
  const room = Math.floor(Math.max(0, Math.min(11, height - fixed - 4)) / 5) * 5;
  const cardsHeight = Math.min(room, Math.ceil(rows.length / cols) * 5);
  const logRows = Math.max(3, height - fixed - cardsHeight);
  const gap = 1;
  const cardW = Math.floor((width - gap * (cols - 1)) / cols);
  const cardRows = Math.floor(cardsHeight / 5);
  const capacity = cardRows * cols;

  const rank = { running: 0, failed: 1, queued: 2, cached: 3, done: 3, cancelled: 4 } as const;
  const sorted = [...rows].sort((a, b) => rank[a.status] - rank[b.status]);
  const overflow = capacity > 0 && sorted.length > capacity;
  const shown = capacity > 0 ? sorted.slice(0, overflow ? capacity - 1 : capacity) : [];
  const hidden = sorted.slice(shown.length);
  const tally = (s: Shard["status"][]) => hidden.filter((h) => s.includes(h.status)).length;

  const flowW = Math.floor((width - 3 * 5) / 4);
  const t = progress.tokens;
  const log: ReactNode[] = progress.log.map((l, i) => (
    <Text key={`${i}-${l.at}`} wrap="truncate">
      <Text dimColor>{clock(l.at)} </Text>
      <Text color={l.tone === "dim" ? T.gray : T[l.tone]}>{truncate(l.tag, 18).padEnd(18)} </Text>
      <Text {...(l.tone === "dim" ? { dimColor: true } : {})}>{l.text}</Text>
    </Text>
  ));
  const elapsed = progress.startedAt ? mmss(Date.now() - progress.startedAt) : "0m00s";
  const banner = notice
    ? { tone: T.yellow, text: notice }
    : progress.budget
      ? {
          tone: T.red,
          text: `Local shard budget: ${progress.budget.required} runs needed, limit ${progress.budget.limit}. b approves ${progress.budget.required} shards for this run; another provider does not change this limit.`,
        }
      : progress.failed
        ? { tone: T.red, text: `Review failed: ${progress.failed}` }
        : progress.rateLimited && progress.done
          ? {
              tone: T.yellow,
              text: "Provider rate limited. P switches provider, m changes model, r retries (finished files are cached).",
            }
          : progress.partial
            ? { tone: T.yellow, text: progress.partial }
            : undefined;
  const changed =
    selection.provider ||
    selection.model !== undefined ||
    selection.effort !== undefined ||
    selection.depth;

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box justifyContent="space-between" width={width}>
        <Text wrap="truncate">
          <Text bold color={T.mint}>
            {" "}
            crit
          </Text>
          <Text dimColor> · </Text>
          <Text>{progress.scope?.label ?? "starting…"}</Text>
        </Text>
        <Text wrap="truncate">
          <Text color={T.lav}>■ </Text>
          <Text>
            {provider || "…"}
            {model ? ` ${model}` : ""}
          </Text>
          <Text dimColor> T+{elapsed} </Text>
        </Text>
      </Box>
      {showFlow ? (
        <Box width={width}>
          <Node
            title="scope"
            width={flowW}
            state={progress.scope ? "done" : "active"}
            lines={[
              `${progress.scope?.files ?? 0} files`,
              `${progress.scope?.skipped ?? 0} skipped${progress.cache ? ` · ${progress.cache.files} cached` : ""}`,
            ]}
          />
          <Flow active={phase === "plan"} tick={tick} />
          <Node
            title="rules"
            width={flowW}
            state={progress.rules ? "done" : "idle"}
            lines={[
              `${progress.rules?.attached.length ?? 0} attached`,
              `${progress.rules?.listed ?? 0} listed${progress.rules?.conflicts ? ` · ${progress.rules.conflicts} conflict` : ""}`,
            ]}
          />
          <Flow active={phase === "plan" || phase === "review"} tick={tick} />
          <Node
            title="review"
            width={flowW}
            state={phase === "review" ? "active" : phase === "plan" ? "idle" : "done"}
            lines={[`${doneCount}/${rows.length} runs`, `${progress.findings} findings`]}
          />
          <Flow active={phase === "review" || phase === "verify"} tick={tick} />
          <Node
            title="skeptic"
            width={flowW}
            state={phase === "verify" ? "active" : phase === "done" ? "done" : "idle"}
            lines={[
              progress.verifying
                ? `${progress.verified}/${progress.verifying} checked`
                : phase === "done"
                  ? "finished"
                  : "waiting",
              depth,
            ]}
          />
        </Box>
      ) : null}
      {capacity > 0 ? (
        <Box flexDirection="column" height={cardsHeight} overflow="hidden">
          <Box flexWrap="wrap" columnGap={gap} width={width}>
            {shown.map((r) => {
              const tone = STATUS_TONE[r.status];
              const mark =
                r.status === "done" || r.status === "cached"
                  ? "[✓]"
                  : r.status === "queued"
                    ? "[ ]"
                    : "[✗]";
              return (
                <Panel key={r.shard.id} title={r.shard.label} tone={tone} width={cardW} height={5}>
                  <Text wrap="truncate" dimColor>
                    {r.shard.lenses.join(", ")}
                  </Text>
                  <Text wrap="truncate">
                    {r.status === "running" ? <Spinner /> : <Text color={T[tone]}>{mark}</Text>}{" "}
                    {r.status === "queued" ? (
                      <Text dimColor>queued</Text>
                    ) : (
                      <Text dimColor={r.status === "running"}>{r.text ?? "starting…"}</Text>
                    )}
                  </Text>
                  <Text wrap="truncate" dimColor>
                    {r.findings} finding{r.findings === 1 ? "" : "s"}
                    {r.durationMs ? ` · ${mmss(r.durationMs)}` : ""}
                  </Text>
                </Panel>
              );
            })}
            {overflow ? (
              <Box width={cardW} height={5} paddingX={1} alignItems="center">
                <Text dimColor wrap="truncate">
                  + {hidden.length} more: ✓ {tally(["done", "cached"])} · queued {tally(["queued"])}
                  {tally(["failed", "cancelled"]) ? ` · ✗ ${tally(["failed", "cancelled"])}` : ""}
                </Text>
              </Box>
            ) : null}
          </Box>
        </Box>
      ) : null}
      <Text wrap="truncate">
        <Text dimColor> tokens </Text>
        <Bar
          value={t?.spent ?? 0}
          max={t?.budget ?? 1}
          width={Math.max(10, Math.min(40, width - 40))}
        />
        <Text> {formatTokens(t?.spent ?? 0)}</Text>
        <Text dimColor> / {formatTokens(t?.budget ?? 0)}</Text>
        {progress.partial ? <Text color={T.yellow}> stopped early</Text> : null}
        {progress.failed ? <Text color={T.red}> failed</Text> : null}
      </Text>
      {banner ? (
        <Text color={banner.tone} wrap="truncate">
          {` ${banner.text}`}
        </Text>
      ) : (
        <Text dimColor wrap="truncate">
          {` ── session log ${"─".repeat(Math.max(0, width - 17))}`}
        </Text>
      )}
      <Viewport lines={log} height={logRows} width={width} follow active={false} />
      <StatusBar
        width={width}
        items={[
          ...(changed ? [{ k: "next run", v: "changed; r retries", tone: "yellow" as const }] : []),
          { k: "provider", v: provider || "…", tone: "lav" },
          { k: "model", v: model ?? "default", tone: "lav" },
          { k: "effort", v: eff ?? "default", tone: "orange" },
          { k: "depth", v: selection.depth ?? depth, tone: "orange" },
          { k: "shards", v: `${doneCount}/${rows.length}`, tone: "mint" },
          { k: "findings", v: String(progress.findings), tone: "mint" },
        ]}
      />
      <Footer
        width={width}
        keys={[
          ["q", progress.done ? "quit" : "stop"],
          ["enter", "findings so far"],
          ...(progress.budget
            ? ([["b", `approve ${progress.budget.required} shards`]] as [string, string][])
            : []),
          ...(progress.done ? ([["r", "retry"]] as [string, string][]) : []),
          ["m", "model"],
          ["p", "provider"],
          ["e", "effort"],
          ["d", "depth"],
        ]}
      />
    </Box>
  );
};
