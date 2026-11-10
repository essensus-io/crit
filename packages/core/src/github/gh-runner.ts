import { x } from "tinyexec";

export type GhResult = { stdout: string; stderr: string; exitCode: number };

export type GhRunner = (cwd: string, args: string[], input?: string) => Promise<GhResult>;

export class GhError extends Error {
  override name = "GhError";
}

const GH_MISSING =
  "crit: the GitHub CLI (gh) is not installed. Get it from https://cli.github.com, then run `gh auth login`.";

const isMissingBinary = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

export const createGhRunner = (): GhRunner => async (cwd, args, input) => {
  try {
    const proc = x("gh", args, {
      nodeOptions: { cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] },
      throwOnError: false,
    });
    if (input !== undefined) proc.process?.stdin?.end(input);
    const output = await proc;
    return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode ?? 1 };
  } catch (err) {
    if (isMissingBinary(err)) throw new GhError(GH_MISSING);
    throw err;
  }
};

export async function runGh(
  gh: GhRunner,
  cwd: string,
  args: string[],
  input?: string,
): Promise<string> {
  const result = await gh(cwd, args, input);
  if (result.exitCode !== 0)
    throw new GhError(`crit: gh ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}
