import * as p from "@clack/prompts";

export type Option<T> = { value: T; label: string; hint?: string; disabled?: boolean };

export type Prompter = {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  info(message: string): void;
  warn(message: string): void;
  success(message: string): void;
  error(message: string): void;
  text(opts: {
    message: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (v: string) => string | undefined;
  }): Promise<string>;
  select<T>(opts: { message: string; options: Option<T>[]; initialValue?: T }): Promise<T>;
  autocomplete<T>(opts: {
    message: string;
    options: Option<T>[];
    initialValue?: T;
    placeholder?: string;
  }): Promise<T>;
  multiselect<T>(opts: {
    message: string;
    options: Option<T>[];
    initialValues?: T[];
    required?: boolean;
  }): Promise<T[]>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>;
  spinner(): { start(message: string): void; stop(message: string, failed?: boolean): void };
};

export class PromptCancelled extends Error {
  override name = "PromptCancelled";
  constructor() {
    super("cancelled");
  }
}

function unwrap<T>(v: unknown): T {
  if (p.isCancel(v)) throw new PromptCancelled();
  return v as T;
}

export const createClackPrompter = (): Prompter => ({
  intro: (m: string) => p.intro(m),
  outro: (m: string) => p.outro(m),
  note: (m: string, t?: string) => p.note(m, t),
  info: (m: string) => p.log.info(m),
  warn: (m: string) => p.log.warn(m),
  success: (m: string) => p.log.success(m),
  error: (m: string) => p.log.error(m),
  async text(o: Parameters<Prompter["text"]>[0]) {
    return unwrap<string>(
      await p.text({
        message: o.message,
        ...(o.initialValue !== undefined ? { initialValue: o.initialValue } : {}),
        ...(o.placeholder !== undefined ? { placeholder: o.placeholder } : {}),
        ...(o.validate ? { validate: (v: string | undefined) => o.validate!(v ?? "") } : {}),
      }),
    );
  },
  async select<T>(o: { message: string; options: Option<T>[]; initialValue?: T }) {
    return unwrap<T>(
      await p.select<T>({
        message: o.message,
        options: o.options as never,
        ...(o.initialValue !== undefined ? { initialValue: o.initialValue } : {}),
      }),
    );
  },
  async autocomplete<T>(o: {
    message: string;
    options: Option<T>[];
    initialValue?: T;
    placeholder?: string;
  }) {
    return unwrap<T>(
      await p.autocomplete<T>({
        message: o.message,
        options: o.options as never,
        maxItems: 10,
        ...(o.placeholder ? { placeholder: o.placeholder } : {}),
        ...(o.initialValue !== undefined ? { initialValue: o.initialValue } : {}),
      }),
    );
  },
  async multiselect<T>(o: {
    message: string;
    options: Option<T>[];
    initialValues?: T[];
    required?: boolean;
  }) {
    return unwrap<T[]>(
      await p.multiselect<T>({
        message: o.message,
        options: o.options as never,
        ...(o.initialValues ? { initialValues: o.initialValues } : {}),
        required: o.required ?? false,
      }),
    );
  },
  async confirm(o: { message: string; initialValue?: boolean }) {
    return unwrap<boolean>(
      await p.confirm({
        message: o.message,
        ...(o.initialValue !== undefined ? { initialValue: o.initialValue } : {}),
      }),
    );
  },
  spinner() {
    const spinnerResult = p.spinner();
    return {
      start: (m: string) => spinnerResult.start(m),
      stop: (m: string, failed?: boolean) =>
        failed ? spinnerResult.error(m) : spinnerResult.stop(m),
    };
  },
});

type Answer = string | boolean | string[] | ((question: string) => unknown);

export const createScriptedPrompter = (initialAnswers: Answer[] = []) => {
  const log: string[] = [];
  const answers = [...initialAnswers];
  const next = (question: string, fallback: unknown): unknown => {
    log.push(`? ${question}`);
    if (answers.length === 0) return fallback;
    const answer = answers.shift()!;
    if (answer === "__cancel__") throw new PromptCancelled();
    return typeof answer === "function" ? answer(question) : answer;
  };
  const select = async <T>(o: { message: string; options: Option<T>[]; initialValue?: T }) => {
    const value = next(
      o.message,
      o.initialValue ?? o.options.find((option) => !option.disabled)?.value,
    );
    const hit = o.options.find((option) => option.value === value || option.label === value);
    if (!hit) throw new Error(`no option ${String(value)} for "${o.message}"`);
    return hit.value;
  };
  return {
    log,
    intro: (m: string) => void log.push(`intro ${m}`),
    outro: (m: string) => void log.push(`outro ${m}`),
    note: (m: string, t?: string) => void log.push(`note ${t ?? ""}: ${m}`),
    info: (m: string) => void log.push(`info ${m}`),
    warn: (m: string) => void log.push(`warn ${m}`),
    success: (m: string) => void log.push(`success ${m}`),
    error: (m: string) => void log.push(`error ${m}`),
    async text(o: Parameters<Prompter["text"]>[0]) {
      const value = String(next(o.message, o.initialValue ?? ""));
      const invalid = o.validate?.(value);
      if (invalid) throw new Error(`invalid answer for "${o.message}": ${invalid}`);
      return value;
    },
    select,
    autocomplete: select,
    async multiselect<T>(o: { message: string; options: Option<T>[]; initialValues?: T[] }) {
      const value = next(o.message, o.initialValues ?? []) as unknown[];
      return o.options
        .filter((option) => value.includes(option.value) || value.includes(option.label))
        .map((option) => option.value);
    },
    async confirm(o: { message: string; initialValue?: boolean }) {
      return Boolean(next(o.message, o.initialValue ?? true));
    },
    spinner: () => ({
      start: (m: string) => void log.push(`spin ${m}`),
      stop: (m: string, failed?: boolean) => void log.push(`${failed ? "fail" : "done"} ${m}`),
    }),
  } satisfies Prompter & { log: string[] };
};

export type ScriptedPrompter = ReturnType<typeof createScriptedPrompter>;
