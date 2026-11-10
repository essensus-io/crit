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

export type ReviewInput =
  | { kind: "patch"; patch: string }
  | { kind: "description"; text: string }
  | undefined;
