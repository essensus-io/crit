import type { Depth } from "@crit/schema";
import { Box, Text, useInput } from "ink";
import { type ReactNode, useState } from "react";
import { TextInput } from "./components.tsx";
import { useScreen } from "./screen.tsx";
import { describeChoice, type Switcher } from "./switcher.ts";
import { Panel, Picker, type PickOption } from "./widgets.tsx";

const DEFAULT = "__default__";
const CUSTOM = "__custom__";
const CONNECT = "__connect__";

type Stage =
  | { kind: "model"; options: PickOption<string>[]; live: boolean }
  | { kind: "custom-model" }
  | { kind: "provider"; options: PickOption<string>[] }
  | { kind: "effort"; options: PickOption<string>[] }
  | { kind: "depth"; options: PickOption<Depth>[] };

export const DEPTH_HINTS: Record<Depth, string> = {
  quick: "core lenses, no skeptic, low effort",
  standard: "every lens in one pass, skeptic skips nits",
  deep: "lenses split, skeptic checks all, high effort",
};

/**
 * The model/provider/effort/depth shortcuts. `m`, `P`, `E`, `D` open a searchable
 * picker as a full-screen overlay (it never leaves the alternate screen) and
 * `S` saves the current choice as the profile's default. While an overlay is
 * open `modal` is true and the screen should ignore its own keys.
 */
export function useSwitching(opts: {
  switcher: Switcher | undefined;
  /** Keys are live only while this is true (a text prompt elsewhere turns them off). */
  active: boolean;
  onNotice: (message: string) => void;
  /** "Connect another provider…" was picked. */
  onConnect?: () => void;
  /** The choice changed (re-render, rebuild the provider). */
  onChange?: () => void;
  /** Off when the screen opens the pickers itself (through `open`). */
  hotkeys?: boolean;
}): { overlay: ReactNode; modal: boolean; open: (key: "m" | "p" | "e" | "d" | "s") => void } {
  const { switcher, active, onNotice } = opts;
  const screen = useScreen();
  const [stage, setStage] = useState<Stage | undefined>();

  const changed = (verb: string) => {
    opts.onChange?.();
    const c = switcher!.current();
    const save = (opts.hotkeys ?? true) ? "S saves" : "o then s saves";
    onNotice(`${verb}: ${describeChoice(c)}. ${save} it as the default for ${c.provider}.`);
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
          note={stage.live ? "from the CLI" : "built-in list"}
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
            switcher.setProvider(v);
            changed("Provider");
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
  return { overlay, modal: true, open: trigger };
}
