import { formatTokens, type ScopeSpec } from "@crit/schema";
import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { Footer, TextInput } from "../../shared/ui/index.ts";
import { useScreen } from "../../shared/ui/index.ts";
import {
  describeChoice,
  type Choice,
  type Switcher,
} from "../../features/model-switching/index.ts";
import { T } from "../../shared/lib/index.ts";
import { useSwitching } from "../../features/model-switching/index.ts";
import { Menu, Panel, Spinner } from "../../shared/ui/index.ts";
import { truncate } from "../../shared/lib/index.ts";

export type HomeChoice =
  | { kind: "start"; spec: ScopeSpec; choice: Choice | undefined }
  | { kind: "open"; reviewId: string }
  | { kind: "quit" };

export type RecentReview = {
  id: string;
  label: string;
  when: string;
  findings: string;
  outcome: string;
};

export type Estimate =
  | { ok: true; files: number; skipped: number; runs: number; tokens: number; cached: number }
  | { ok: false; message: string };

export type HomeInfo = { repo: string; branch?: string | undefined; base?: string | undefined };

type Option = { id: string; label: string; hint: string; spec: ScopeSpec | undefined };

const optionsFor = (base: string | undefined): Option[] => [
  {
    id: "branch",
    label: base
      ? `This branch vs ${/^[0-9a-f]{40}$/.test(base) ? `${base.slice(0, 8)} (just before its merge)` : base}`
      : "This branch",
    hint: "what you changed since it left the base branch, plus uncommitted work",
    spec: { kind: "branch", ...(base ? { base } : {}) },
  },
  {
    id: "staged",
    label: "Staged changes",
    hint: "what `git add` has prepared",
    spec: { kind: "staged" },
  },
  { id: "commit", label: "Last commit", hint: "HEAD only", spec: { kind: "commit", sha: "HEAD" } },
  {
    id: "project",
    label: "Whole project",
    hint: "every tracked file: the most tokens",
    spec: { kind: "project" },
  },
  {
    id: "paths",
    label: "Specific paths…",
    hint: "folders, files or globs you type",
    spec: undefined,
  },
];

const indexOfSpec = (spec: ScopeSpec | undefined) =>
  spec ? Math.max(0, ["branch", "staged", "commit", "project", "paths"].indexOf(spec.kind)) : 0;
type Props = {
  info: HomeInfo;
  bases?: { ref: string; ahead: number }[];
  recent: RecentReview[];
  initialSpec?: ScopeSpec | undefined;
  switcher?: Switcher | undefined;
  estimate: (spec: ScopeSpec) => Promise<Estimate>;
  onDone: (choice: HomeChoice) => void;
};

export const HomeView = (props: Props) => {
  const app = useApp();
  const { width, height } = useScreen();
  const [base, setBase] = useState(props.info.base);
  const options = optionsFor(base);
  const [sel, setSel] = useState(indexOfSpec(props.initialSpec));
  const [paths, setPaths] = useState(
    props.initialSpec?.kind === "paths" ? props.initialSpec.paths.join(" ") : "",
  );
  const [focus, setFocus] = useState<"scope" | "recent">("scope");
  const [recentAt, setRecentAt] = useState(0);
  const [mode, setMode] = useState<"none" | "paths" | "options" | "base">("none");
  const [estimate, setEstimate] = useState<Estimate | "loading" | "idle">("idle");
  const [notice, setNotice] = useState<string>();
  const [, bump] = useState(0);
  const latest = useRef(0);

  const specFor = (index: number): ScopeSpec | undefined => {
    const opt = options[index]!;
    if (opt.id !== "paths") return opt.spec;
    const list = paths.split(/\s+/).filter(Boolean);
    return list.length ? { kind: "paths", paths: list, diff: false } : undefined;
  };
  const spec = specFor(sel);

  useEffect(() => {
    const ticket = ++latest.current;
    if (!spec) return setEstimate("idle");
    setEstimate("loading");
    void props.estimate(spec).then((e) => {
      if (ticket === latest.current) setEstimate(e);
    });
  }, [sel, paths, base]);

  const switching = useSwitching({
    switcher: props.switcher,
    active: mode === "none",
    hotkeys: false,
    onNotice: setNotice,
    onChange: () => bump((n) => n + 1),
  });

  const finish = (choice: HomeChoice) => {
    props.onDone(choice);
    app.exit();
  };
  const start = () => {
    if (!spec) {
      setNotice("Type the paths to review first.");
      return setMode("paths");
    }
    if (estimate !== "loading" && estimate !== "idle" && estimate.ok && estimate.files === 0)
      return setNotice("Nothing to review in that scope. Pick another.");
    finish({ kind: "start", spec, choice: props.switcher?.current() });
  };

  useInput(
    (typed, key) => {
      const input = typed.toLowerCase();
      setNotice(undefined);
      if (input === "q" || key.escape) return finish({ kind: "quit" });
      if (input === "o") return setMode("options");
      if (input === "b" && (props.bases?.length ?? 0) > 1) return setMode("base");
      if (key.tab || input === "h" || input === "l" || key.leftArrow || key.rightArrow) {
        if (props.recent.length === 0) return;
        return setFocus((f) => (f === "scope" ? "recent" : "scope"));
      }
      const down = input === "j" || key.downArrow;
      const up = input === "k" || key.upArrow;
      if (focus === "recent") {
        if (down) return setRecentAt((i) => Math.min(props.recent.length - 1, i + 1));
        if (up) return setRecentAt((i) => Math.max(0, i - 1));
        if (key.return && props.recent[recentAt])
          return finish({ kind: "open", reviewId: props.recent[recentAt]!.id });
        return;
      }
      if (down) return setSel((i) => Math.min(options.length - 1, i + 1));
      if (up) return setSel((i) => Math.max(0, i - 1));
      if (input === "p" || (key.return && options[sel]!.id === "paths" && !spec))
        return setMode("paths");
      if (key.return || input === "s") return start();
    },
    { isActive: mode === "none" && !switching.modal },
  );

  if (switching.overlay) return switching.overlay;
  if (mode === "base" && props.bases) {
    return (
      <Menu
        title="compare this branch against"
        width={width}
        height={height}
        items={props.bases.map((b, i) => ({
          key: String(i + 1),
          label: b.ref + (b.ref === base ? "  (current)" : ""),
          hint: b.ahead === 0 ? "already merged: nothing to review" : `${b.ahead} commits ahead`,
        }))}
        onCancel={() => setMode("none")}
        onPick={(k) => {
          setBase(props.bases![Number(k) - 1]?.ref ?? base);
          setSel(0);
          setMode("none");
        }}
      />
    );
  }
  if (mode === "options" && props.switcher) {
    const c = props.switcher.current();
    return (
      <Menu
        title="options · used for the review you start"
        width={width}
        height={height}
        items={[
          { key: "m", label: "Model", hint: c.model ?? "CLI default" },
          { key: "p", label: "Provider", hint: c.provider },
          { key: "e", label: "Reasoning effort", hint: c.effort ?? "CLI default" },
          { key: "d", label: "Review depth", hint: c.depth },
          { key: "s", label: "Save this as the default", hint: describeChoice(c) },
        ]}
        onCancel={() => setMode("none")}
        onPick={(k) => {
          setMode("none");
          switching.open(k as "m" | "p" | "e" | "d" | "s");
        }}
      />
    );
  }

  const leftW = Math.min(64, Math.max(44, Math.floor(width * 0.55)));
  const rightW = width - leftW - 1;
  const panelH = Math.max(12, Math.min(height - 4, 17));
  const choice = props.switcher?.current();

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Text wrap="truncate">
        <Text bold color={T.mint}>
          {" "}
          crit
        </Text>
        <Text dimColor> · </Text>
        <Text>{props.info.repo}</Text>
        {props.info.branch ? <Text dimColor>{` · on ${props.info.branch}`}</Text> : null}
      </Text>
      <Box width={width} height={panelH}>
        <Panel
          title="what to review"
          tone={focus === "scope" ? "orange" : "mint"}
          width={leftW}
          height={panelH}
        >
          {options.map((o, i) => (
            <Text key={o.id} wrap="truncate" {...(i === sel ? { inverse: focus === "scope" } : {})}>
              <Text color={i === sel ? T.orange : T.gray}>{i === sel ? "●" : "○"}</Text>
              {` ${o.label}`}
              {o.id === "paths" && paths ? <Text color={T.cyan}>{`  ${paths}`}</Text> : null}
            </Text>
          ))}
          <Text> </Text>
          <Text dimColor wrap="truncate">
            {options[sel]!.hint}
          </Text>
          <Text> </Text>
          {estimate === "loading" ? (
            <Text>
              <Spinner /> <Text dimColor>looking at the files…</Text>
            </Text>
          ) : estimate === "idle" ? (
            <Text dimColor>Press enter to type the paths.</Text>
          ) : estimate.ok ? (
            <>
              <Text wrap="truncate">
                <Text
                  color={T.mint}
                >{`${estimate.files} file${estimate.files === 1 ? "" : "s"}`}</Text>
                <Text dimColor>{` · ${estimate.runs} run${estimate.runs === 1 ? "" : "s"}`}</Text>
              </Text>
              <Text wrap="truncate">
                <Text color={T.orange}>{`~${formatTokens(estimate.tokens)} tokens`}</Text>
                {estimate.cached ? <Text dimColor>{` · ${estimate.cached} cached`}</Text> : null}
                {estimate.skipped ? <Text dimColor>{` · ${estimate.skipped} skipped`}</Text> : null}
              </Text>
              {estimate.tokens > 1_000_000 && options[sel]!.id === "branch" ? (
                <Text color={T.yellow} wrap="wrap">
                  {(props.bases?.length ?? 0) > 1
                    ? "That is a lot for one branch: the base may be wrong. Press b to pick another."
                    : "That is a lot of tokens for one branch."}
                </Text>
              ) : null}
            </>
          ) : (
            <Text color={T.red} wrap="truncate">
              {estimate.message}
            </Text>
          )}
          <Text> </Text>
          <Text bold color={T.mint}>
            ▶ Start review
            <Text dimColor bold={false}>
              {"   enter"}
            </Text>
          </Text>
        </Panel>
        <Box width={1} />
        <Panel
          title="recent reviews"
          tone={focus === "recent" ? "orange" : "mint"}
          width={rightW}
          height={panelH}
        >
          {props.recent.length === 0 ? <Text dimColor>None yet in this repository.</Text> : null}
          {props.recent.slice(0, Math.floor((panelH - 3) / 2)).map((r, i) => (
            <Box key={r.id} flexDirection="column">
              <Text
                wrap="truncate"
                {...(focus === "recent" && i === recentAt ? { inverse: true } : {})}
              >
                <Text color={T.cyan}>{r.id.slice(-4)}</Text>
                {` ${truncate(r.label, Math.max(8, rightW - 10))}`}
              </Text>
              <Text
                dimColor
                wrap="truncate"
              >{`     ${r.when} · ${r.findings} · ${r.outcome}`}</Text>
            </Box>
          ))}
        </Panel>
      </Box>
      {mode === "paths" ? (
        <TextInput
          label="Paths to review (folders, files or globs, space separated) ›"
          initial={paths}
          onCancel={() => setMode("none")}
          onSubmit={(v) => {
            setPaths(v.trim());
            setMode("none");
            setSel(options.findIndex((o) => o.id === "paths"));
          }}
        />
      ) : notice ? (
        <Text color={T.yellow}> {notice}</Text>
      ) : choice ? (
        <Text wrap="truncate">
          {" "}
          <Text dimColor>reviewer </Text>
          <Text color={T.lav}>{describeChoice(choice)}</Text>
          <Text dimColor>{"   o to change"}</Text>
        </Text>
      ) : (
        <Text> </Text>
      )}
      <Footer
        width={width}
        keys={
          focus === "recent"
            ? [
                ["j/k", "choose"],
                ["enter", "open that review"],
                ["tab", "back"],
                ["q", "quit"],
              ]
            : [
                ["j/k", "choose"],
                ["enter", "start"],
                ...(props.recent.length ? ([["tab", "recent reviews"]] as [string, string][]) : []),
                ...((props.bases?.length ?? 0) > 1 && options[sel]!.id === "branch"
                  ? ([["b", "change base"]] as [string, string][])
                  : []),
                ["o", "model & depth"],
                ["q", "quit"],
              ]
        }
      />
    </Box>
  );
};
