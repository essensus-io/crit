import type { Depth } from "@crit/schema";
import { Box, Text, useInput } from "ink";
import { Fragment, type ReactNode, useState } from "react";
import { TextInput } from "../../../shared/ui/index.ts";
import { useScreen } from "../../../shared/ui/index.ts";
import { describeChoice } from "../lib/describe-choice.ts";
import { type Switcher } from "../lib/create-switcher.ts";
import { Panel, Picker, type PickOption } from "../../../shared/ui/index.ts";

const DEFAULT = "__default__";
const CUSTOM = "__custom__";
const CONNECT = "__connect__";
const ADD = "__add__";
const REMOVE = "__remove__";

type Stage =
  | { kind: "model"; options: PickOption<string>[]; live: boolean }
  | { kind: "custom-model" }
  | { kind: "provider"; options: PickOption<string>[] }
  | { kind: "add-type" }
  | { kind: "add-name"; type: string; accountVar?: string }
  | { kind: "add-account"; type: string; name: string; accountVar: string }
  | { kind: "remove" }
  | { kind: "remove-confirm"; name: string }
  | { kind: "effort"; options: PickOption<string>[] }
  | { kind: "depth"; options: PickOption<Depth>[] };

export const DEPTH_HINTS: Record<Depth, string> = {
  quick: "core lenses, no skeptic, low effort",
  standard: "every lens in one pass, skeptic skips nits",
  deep: "lenses split, skeptic checks all, high effort",
};

export const useSwitching = (opts: {
  switcher: Switcher | undefined;
  active: boolean;
  onNotice: (message: string) => void;
  onConnect?: () => void;
  onChange?: () => void;
  hotkeys?: boolean;
}): { overlay: ReactNode; modal: boolean; open: (key: "m" | "p" | "e" | "d" | "s") => void } => {
  const { switcher, active, onNotice } = opts;
  const screen = useScreen();
  const [stage, setStage] = useState<Stage | undefined>();

  const changed = (verb: string) => {
    opts.onChange?.();
    const c = switcher!.current();
    const save = (opts.hotkeys ?? true) ? "S saves" : "o then s saves";
    onNotice(`${verb}: ${describeChoice(c)}. ${save} it as the default for ${c.provider}.`);
  };

  const finishAdd = (type: string, name: string, account?: string) => {
    try {
      switcher!.add({ type, name, ...(account ? { account } : {}) });
    } catch (err) {
      setStage(undefined);
      return onNotice((err as Error).message);
    }
    opts.onChange?.();
    setStage(undefined);
    onNotice(`Added ${name}. Pick its model with o, then m; s saves the choice.`);
  };

  const trigger = (typed: string) => {
    if (!switcher) return;
    const input = typed.toLowerCase();
    const c = switcher.current();
    if (input === "m") {
      void switcher.models().then(({ models, live }) => {
        if (models.length === 0) return setStage({ kind: "custom-model" });
        setStage({
          kind: "model",
          live,
          options: [
            { value: DEFAULT, label: "CLI default", hint: "the agent CLI's own choice" },
            ...models.map((m) => ({
              value: m.id,
              label: m.label,
              hint: [m.id !== m.label ? m.id : "", m.hint ?? ""].filter(Boolean).join(" · "),
            })),
            { value: CUSTOM, label: "Other…", hint: "type a model name" },
          ],
        });
      });
    } else if (input === "p") {
      setStage({
        kind: "provider",
        options: [
          ...switcher.providers().map((p) => ({
            value: p.name,
            label: p.name,
            hint: `${p.type} · ${p.model ?? "default model"}`,
          })),
          {
            value: ADD,
            label: "Add a provider or account…",
            hint: "another login, or the same CLI with a different model",
          },
          ...(switcher.providers().length > 1
            ? [{ value: REMOVE, label: "Remove a provider…", hint: "asks first" }]
            : []),
          ...(opts.onConnect
            ? [{ value: CONNECT, label: "Connect another provider…", hint: "crit providers add" }]
            : []),
        ],
      });
    } else if (input === "e") {
      void switcher.efforts().then((efforts) => {
        if (efforts.length === 0)
          return onNotice(`${c.provider} has no separate effort setting: pick a model instead.`);
        setStage({
          kind: "effort",
          options: [
            { value: DEFAULT, label: "CLI default" },
            ...efforts.map((e) => ({ value: e, label: e })),
          ],
        });
      });
    } else if (input === "d") {
      setStage({
        kind: "depth",
        options: (["quick", "standard", "deep"] as const).map((d) => ({
          value: d,
          label: d,
          hint: DEPTH_HINTS[d],
        })),
      });
    } else if (input === "s") {
      onNotice(`Saved ${describeChoice(c)} as the default for ${switcher.save()}.`);
    }
  };
  useInput(trigger, {
    isActive: (opts.hotkeys ?? true) && active && !stage && Boolean(switcher),
  });

  if (!stage || !switcher) return { overlay: null, modal: false, open: trigger };
  const close = () => setStage(undefined);
  const c = switcher.current();
  const common = { width: screen.width, height: screen.height, onCancel: close };
  let overlay: ReactNode;
  switch (stage.kind) {
    case "model":
      overlay = (
        <Picker
          {...common}
          title={`model · ${c.provider}`}
          options={stage.options}
          initial={c.model ?? DEFAULT}
          note={
            stage.live
              ? "live list"
              : switcher.providers().find((p) => p.name === c.provider)?.type === "claude-code"
                ? "built-in list · with ANTHROPIC_API_KEY set, crit fetches the live one"
                : "built-in list"
          }
          onPick={(v) => {
            if (v === CUSTOM) return setStage({ kind: "custom-model" });
            close();
            switcher.setModel(v === DEFAULT ? null : v);
            changed("Model");
          }}
        />
      );
      break;
    case "custom-model":
      overlay = (
        <Box flexDirection="column" width={screen.width} height={screen.height}>
          <Panel title={`model · ${c.provider}`} tone="lav" width={Math.min(screen.width - 2, 70)}>
            <TextInput
              label="Model name ›"
              initial={c.model ?? ""}
              onCancel={close}
              onSubmit={(v) => {
                close();
                if (!v.trim()) return;
                switcher.setModel(v.trim());
                changed("Model");
              }}
            />
          </Panel>
          <Text dimColor> enter confirm · esc cancel</Text>
        </Box>
      );
      break;
    case "provider":
      overlay = (
        <Picker
          {...common}
          title="provider"
          options={stage.options}
          initial={c.provider}
          onPick={(v) => {
            close();
            if (v === CONNECT) return opts.onConnect?.();
            if (v === ADD) return setStage({ kind: "add-type" });
            if (v === REMOVE) return setStage({ kind: "remove" });
            switcher.setProvider(v);
            changed("Provider");
          }}
        />
      );
      break;
    case "add-type":
      overlay = (
        <Picker
          {...common}
          title="add a provider"
          options={switcher.types().map((t) => ({ value: t.type, label: t.label, hint: t.type }))}
          onPick={(type) => {
            const t = switcher.types().find((x) => x.type === type);
            setStage({
              kind: "add-name",
              type,
              ...(t?.accountVar ? { accountVar: t.accountVar } : {}),
            });
          }}
        />
      );
      break;
    case "add-name":
      overlay = (
        <Box flexDirection="column" width={screen.width} height={screen.height}>
          <Panel title={`add ${stage.type}`} tone="lav" width={Math.min(screen.width - 2, 70)}>
            <TextInput
              label="Name for this setup ›"
              initial={switcher.suggestName(stage.type)}
              onCancel={close}
              onSubmit={(v) => {
                const name = v.trim();
                if (!name) return close();
                if (switcher.providers().some((p) => p.name === name)) {
                  close();
                  return onNotice(`A provider named ${name} already exists.`);
                }
                if (stage.accountVar)
                  return setStage({
                    kind: "add-account",
                    type: stage.type,
                    name,
                    accountVar: stage.accountVar,
                  });
                finishAdd(stage.type, name);
              }}
            />
          </Panel>
          <Text dimColor> enter next · esc cancel</Text>
        </Box>
      );
      break;
    case "add-account":
      overlay = (
        <Box flexDirection="column" width={screen.width} height={screen.height}>
          <Panel title={`add ${stage.name}`} tone="lav" width={Math.min(screen.width - 2, 78)}>
            <TextInput
              label={`Folder of another login (${stage.accountVar}), or enter for the same account ›`}
              onCancel={close}
              onSubmit={(v) => finishAdd(stage.type, stage.name, v.trim() || undefined)}
            />
          </Panel>
          <Text dimColor> enter add · esc cancel</Text>
        </Box>
      );
      break;
    case "remove":
      overlay = (
        <Picker
          {...common}
          title="remove which provider?"
          options={switcher.providers().map((p) => ({
            value: p.name,
            label: p.name,
            hint: `${p.type} · ${p.model ?? "default model"}`,
          }))}
          onPick={(name) => setStage({ kind: "remove-confirm", name })}
        />
      );
      break;
    case "remove-confirm":
      overlay = (
        <Picker
          {...common}
          title={`remove ${stage.name}? This deletes its saved setup.`}
          options={[
            { value: "no", label: "No, keep it" },
            { value: "yes", label: `Yes, remove ${stage.name}` },
          ]}
          initial="no"
          onPick={(v) => {
            close();
            if (v !== "yes") return;
            try {
              switcher.remove(stage.name);
              opts.onChange?.();
              onNotice(`Removed ${stage.name}. Using ${switcher.current().provider}.`);
            } catch (err) {
              onNotice((err as Error).message);
            }
          }}
        />
      );
      break;
    case "effort":
      overlay = (
        <Picker
          {...common}
          title={`reasoning effort · ${c.model ?? c.provider}`}
          options={stage.options}
          initial={c.effort ?? DEFAULT}
          onPick={(v) => {
            close();
            switcher.setEffort(v === DEFAULT ? null : v);
            changed("Effort");
          }}
        />
      );
      break;
    case "depth":
      overlay = (
        <Picker
          {...common}
          title="review depth"
          options={stage.options}
          initial={c.depth}
          onPick={(v) => {
            close();
            switcher.setDepth(v);
            changed("Depth");
          }}
        />
      );
      break;
  }
  return { overlay: <Fragment key={stage.kind}>{overlay}</Fragment>, modal: true, open: trigger };
};
