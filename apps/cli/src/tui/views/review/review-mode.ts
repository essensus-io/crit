export type ReviewMode =
  | "none"
  | "help"
  | "actions"
  | "options"
  | "rules"
  | "search"
  | "dismiss"
  | "propose"
  | "describe"
  | "ask"
  | "reply"
  | "apply"
  | "instruct"
  | "rerun";

/** What the user last gave the proposal check: their patch or their words. */
export type ReviewInput =
  | { kind: "patch"; patch: string }
  | { kind: "description"; text: string }
  | undefined;
