export class CliError extends Error {
  override name = "CliError";
  readonly exitCode: number;
  readonly hint?: string;
  constructor(message: string, opts: { exitCode?: number; hint?: string } = {}) {
    super(message);
    this.exitCode = opts.exitCode ?? 1;
    if (opts.hint) this.hint = opts.hint;
  }
}

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  findings: 3,
  partial: 4,
  cancelled: 130,
} as const;
