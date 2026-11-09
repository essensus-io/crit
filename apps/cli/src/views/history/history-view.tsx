import { shortId } from "@crit/schema";
import { type HistoryRow } from "@crit/store";
import { Box, Text, useApp, useInput } from "ink";
import { useScreen } from "../../shared/ui/index.ts";
import { useState } from "react";
import { compareReviews, outcomeOf, tokensLabel, severitySummary } from "../../commands/history.ts";
import { truncate, when } from "../../ui.ts";
import { ReviewView } from "../review/index.ts";
import { Choice, Footer, HRule, TextInput } from "../../shared/ui/index.ts";
import type { ReviewSession } from "../../features/review-session/index.ts";

type Comparison = Awaited<ReturnType<typeof compareReviews>>;

export type HistoryActions = {
  reload(filter: string): Promise<HistoryRow[]>;
  compare(row: HistoryRow, rows: HistoryRow[]): Promise<Comparison | undefined>;
  remove(row: HistoryRow): Promise<void>;
  open(row: HistoryRow): Promise<ReviewSession>;
};
type Props = {
  initial: HistoryRow[];
  actions: HistoryActions;
  now: number;
  width?: number;
};

export const HistoryView = ({ initial, actions, now, width: widthProp }: Props) => {
  const app = useApp();
  const screen = useScreen();
  const width = widthProp ?? screen.width;
  const [rows, setRows] = useState(initial);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<"none" | "filter" | "delete">("none");
  const [filter, setFilter] = useState("");
  const [cmp, setCmp] = useState<Comparison | undefined>();
  const [session, setSession] = useState<ReviewSession>();
  const [message, setMessage] = useState<string>();
  const row = rows[cursor];

  useInput(
    (input, key) => {
      if (input === "q" || key.escape) {
        if (cmp) return setCmp(undefined);
        return app.exit();
      }
      if (input === "j" || key.downArrow) return setCursor((c) => Math.min(c + 1, rows.length - 1));
      if (input === "k" || key.upArrow) return setCursor((c) => Math.max(c - 1, 0));
      if (input === "/") return setMode("filter");
      if (!row) return;
      if (key.return) return void actions.open(row).then(setSession);
      if (input === "c") {
        void actions
          .compare(row, rows)
          .then((c) =>
            c ? setCmp(c) : setMessage("No earlier review of this scope to compare with."),
          );
        return;
      }
      if (input === "d") return setMode("delete");
    },
    { isActive: mode === "none" && !session },
  );

  if (session) return <ReviewView session={session} onExit={() => setSession(undefined)} />;

  const cols = (r: HistoryRow, i: number) => (
    <Text key={r.review.id} {...(i === cursor ? { inverse: true } : {})}>
      {`${i === cursor ? "›" : " "} ${shortId(r.review.id).padEnd(6)} ${when(r.review.startedAt, now).padEnd(17)} ${truncate(r.review.scopeLabel, 28).padEnd(28)} ${r.review.provider.padEnd(10)} ${severitySummary(r).padEnd(17)} ${tokensLabel(r).padEnd(8)} ${outcomeOf(r)}`}
    </Text>
  );
  return (
    <Box flexDirection="column" width={width}>
      <Text
        dimColor
      >{`  ${"ID".padEnd(6)} ${"WHEN".padEnd(17)} ${"SCOPE".padEnd(28)} ${"PROVIDER".padEnd(10)} ${"FINDINGS".padEnd(17)} ${"TOKENS".padEnd(8)} OUTCOME`}</Text>
      {rows.map(cols)}
      {rows.length === 0 ? <Text dimColor> No reviews match.</Text> : null}
      <Text> </Text>
      <Text dimColor>
        {"  C critical · M major · m minor · n nit"}
        {filter ? `   filter: ${filter}` : ""}
      </Text>
      {cmp ? (
        <Box flexDirection="column">
          <HRule width={width} />
          <Text
            dimColor
          >{`  ${shortId(cmp.older.id)} → ${shortId(cmp.newer.id)} · ${cmp.newer.scopeLabel}`}</Text>
          <Text color="green">{`  ${"fixed".padEnd(11)} ${String(cmp.fixed.length).padStart(3)}   ${truncate(cmp.fixed.map((f) => f.title).join(" · "), width - 22)}`}</Text>
          <Text color="yellow">{`  ${"new".padEnd(11)} ${String(cmp.new.length).padStart(3)}   ${truncate(cmp.new.map((f) => f.title).join(" · "), width - 22)}`}</Text>
          <Text>{`  ${"still open".padEnd(11)} ${String(cmp.stillOpen.length).padStart(3)}   ${truncate(cmp.stillOpen.map((f) => f.title).join(" · "), width - 22)}`}</Text>
        </Box>
      ) : null}
      {message ? <Text color="yellow"> {message}</Text> : null}
      {mode === "filter" ? (
        <TextInput
          label="/"
          initial={filter}
          onCancel={() => setMode("none")}
          onSubmit={(v) => {
            setMode("none");
            setFilter(v);
            void actions.reload(v).then((r) => {
              setRows(r);
              setCursor(0);
            });
          }}
        />
      ) : null}
      {mode === "delete" && row ? (
        <Choice
          label={`Delete review ${shortId(row.review.id)}?`}
          options={[["y", "yes, delete it"]]}
          onCancel={() => setMode("none")}
          onPick={() => {
            setMode("none");
            void actions.remove(row).then(() => {
              setRows((rs) => rs.filter((r) => r.review.id !== row.review.id));
              setCursor((c) => Math.max(0, c - 1));
              setMessage(`Deleted review ${shortId(row.review.id)}`);
            });
          }}
        />
      ) : null}
      <Footer
        width={width}
        keys={[
          ["enter", "open"],
          ["c", "compare with previous"],
          ["/", "filter"],
          ["d", "delete"],
          ["q", "quit"],
        ]}
      />
    </Box>
  );
};

export const previousOf = (row: HistoryRow, rows: HistoryRow[]): HistoryRow | undefined => {
  return rows.find(
    (r) =>
      r.review.startedAt < row.review.startedAt &&
      r.review.scopeLabel === row.review.scopeLabel &&
      r.review.branch === row.review.branch &&
      r.review.repoId === row.review.repoId,
  );
};
