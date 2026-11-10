import { PassThrough } from "node:stream";
import * as clack from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClackPrompter, PromptCancelled, type Prompter } from "@/shared/lib/prompter.ts";

vi.mock("@clack/prompts", () => ({
  text: vi.fn<typeof import("@clack/prompts").text>(),
  select: vi.fn<typeof import("@clack/prompts").select>(),
  autocomplete: vi.fn<typeof import("@clack/prompts").autocomplete>(),
  multiselect: vi.fn<typeof import("@clack/prompts").select>(),
  confirm: vi.fn<typeof import("@clack/prompts").confirm>(),
  isCancel: (value: unknown) => typeof value === "symbol",
}));

const promptMethods = {
  text: clack.text,
  select: clack.select,
  autocomplete: clack.autocomplete,
  multiselect: clack.multiselect,
  confirm: clack.confirm,
};

const options = [{ value: "agent", label: "Agent" }];
const cases: {
  kind: "text" | "select" | "autocomplete" | "multiselect" | "confirm";
  call: (prompter: Prompter) => Promise<unknown>;
  answer: unknown;
}[] = [
  { kind: "text", call: (p) => p.text({ message: "Name" }), answer: "agent" },
  { kind: "select", call: (p) => p.select({ message: "Provider", options }), answer: "agent" },
  {
    kind: "autocomplete",
    call: (p) => p.autocomplete({ message: "Model", options }),
    answer: "agent",
  },
  {
    kind: "multiselect",
    call: (p) => p.multiselect({ message: "Providers", options }),
    answer: ["agent"],
  },
  { kind: "confirm", call: (p) => p.confirm({ message: "Start?" }), answer: false },
];

describe("prompts after a full-screen view releases stdin", () => {
  let input: PassThrough & {
    isTTY: boolean;
    ref: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    input = Object.assign(new PassThrough(), {
      isTTY: true,
      ref: vi.fn<() => void>(),
      unref: vi.fn<() => void>(),
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    input.destroy();
  });

  it.each(cases)(
    "keeps stdin alive until $kind receives an answer",
    async ({ kind, call, answer }) => {
      const pending = Promise.withResolvers<unknown>();
      vi.mocked(promptMethods[kind]).mockReturnValueOnce(pending.promise as never);
      const result = call(createClackPrompter());
      expect(input.ref).toHaveBeenCalledOnce();
      expect(input.unref).not.toHaveBeenCalled();
      pending.resolve(answer);
      expect(await result).toEqual(answer);
      expect(input.unref).toHaveBeenCalledOnce();
    },
  );

  it("releases stdin when the user cancels", async () => {
    vi.mocked(clack.confirm).mockResolvedValueOnce(
      Symbol("cancel") as Awaited<ReturnType<typeof clack.confirm>>,
    );
    await expect(createClackPrompter().confirm({ message: "Start?" })).rejects.toBeInstanceOf(
      PromptCancelled,
    );
    expect(input.unref).toHaveBeenCalledOnce();
  });

  it("releases stdin when a prompt fails", async () => {
    vi.mocked(clack.confirm).mockRejectedValueOnce(new Error("prompt failed"));
    await expect(createClackPrompter().confirm({ message: "Start?" })).rejects.toThrow(
      "prompt failed",
    );
    expect(input.unref).toHaveBeenCalledOnce();
  });

  it("does not change references on non-terminal input", async () => {
    input.isTTY = false;
    vi.mocked(clack.confirm).mockResolvedValueOnce(true);
    expect(await createClackPrompter().confirm({ message: "Start?" })).toBe(true);
    expect(input.ref).not.toHaveBeenCalled();
    expect(input.unref).not.toHaveBeenCalled();
  });
});
