import * as p from "@clack/prompts";

export type Option<T> = { value: T; label: string; hint?: string; disabled?: boolean };

/** Step-by-step prompts behind an interface so setup flows can be tested. */
export interface Prompter {
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
  multiselect<T>(opts: {
    message: string;
    options: Option<T>[];
    initialValues?: T[];
    required?: boolean;
  }): Promise<T[]>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>;
  spinner(): { start(message: string): void; stop(message: string, failed?: boolean): void };
}

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

export class ClackPrompter implements Prompter {
  intro = (m: string) => p.intro(m);
  outro = (m: string) => p.outro(m);
  note = (m: string, t?: string) => p.note(m, t);
  info = (m: string) => p.log.info(m);
  warn = (m: string) => p.log.warn(m);
  success = (m: string) => p.log.success(m);
  error = (m: string) => p.log.error(m);
  async text(o: Parameters<Prompter["text"]>[0]) {
    return unwrap<string>(
      await p.text({
        message: o.message,
        ...(o.initialValue !== undefined ? { initialValue: o.initialValue } : {}),
        ...(o.placeholder !== undefined ? { placeholder: o.placeholder } : {}),
        ...(o.validate ? { validate: (v: string | undefined) => o.validate!(v ?? "") } : {}),
      }),
    );
  }
  async select<T>(o: { message: string; options: Option<T>[]; initialValue?: T }) {
    return unwrap<T>(
      await p.select<T>({
        message: o.message,
        options: o.options as never,
        ...(o.initialValue !== undefined ? { initialValue: o.initialValue } : {}),
      }),
    );
  }
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
  }
  async confirm(o: { message: string; initialValue?: boolean }) {
    return unwrap<boolean>(
      await p.confirm({
        message: o.message,
        ...(o.initialValue !== undefined ? { initialValue: o.initialValue } : {}),
      }),
    );
  }
  spinner() {
    const s = p.spinner();
    return {
      start: (m: string) => s.start(m),
      stop: (m: string, failed?: boolean) => (failed ? s.error(m) : s.stop(m)),
    };
  }
}

type Answer = string | boolean | string[] | ((question: string) => unknown);

/**
 * Prompter for tests: answers come from a queue (in order) and every message
 * is recorded. A missing answer takes the initial value, so tests only script
 * what they change.
 */
export class ScriptedPrompter implements Prompter {
  readonly log: string[] = [];
  private readonly answers: Answer[];
  constructor(answers: Answer[] = []) {
    this.answers = [...answers];
  }
  private next(question: string, fallback: unknown): unknown {
    this.log.push(`? ${question}`);
    if (this.answers.length === 0) return fallback;
    const a = this.answers.shift()!;
    if (a === "__cancel__") throw new PromptCancelled();
    return typeof a === "function" ? a(question) : a;
  }
  intro = (m: string) => void this.log.push(`intro ${m}`);
  outro = (m: string) => void this.log.push(`outro ${m}`);
  note = (m: string, t?: string) => void this.log.push(`note ${t ?? ""}: ${m}`);
  info = (m: string) => void this.log.push(`info ${m}`);
  warn = (m: string) => void this.log.push(`warn ${m}`);
  success = (m: string) => void this.log.push(`success ${m}`);
  error = (m: string) => void this.log.push(`error ${m}`);
  async text(o: Parameters<Prompter["text"]>[0]) {
    const v = String(this.next(o.message, o.initialValue ?? ""));
    const bad = o.validate?.(v);
    if (bad) throw new Error(`invalid answer for "${o.message}": ${bad}`);
    return v;
  }
  async select<T>(o: { message: string; options: Option<T>[]; initialValue?: T }) {
    const v = this.next(o.message, o.initialValue ?? o.options.find((x) => !x.disabled)?.value);
    const hit = o.options.find((x) => x.value === v || x.label === v);
    if (!hit) throw new Error(`no option ${String(v)} for "${o.message}"`);
    return hit.value;
  }
  async multiselect<T>(o: { message: string; options: Option<T>[]; initialValues?: T[] }) {
    const v = this.next(o.message, o.initialValues ?? []) as unknown[];
    return o.options.filter((x) => v.includes(x.value) || v.includes(x.label)).map((x) => x.value);
  }
  async confirm(o: { message: string; initialValue?: boolean }) {
    return Boolean(this.next(o.message, o.initialValue ?? true));
  }
  spinner() {
    return {
      start: (m: string) => void this.log.push(`spin ${m}`),
      stop: (m: string, failed?: boolean) => void this.log.push(`${failed ? "fail" : "done"} ${m}`),
    };
  }
}
