import { GhError, type GhResult, type GhRunner } from "./gh-runner.ts";

export type GhStatus =
  | { kind: "connected"; account: string | undefined }
  | { kind: "signed-out" }
  | { kind: "missing" };

const ACCOUNT = /Logged in to \S+ (?:account|as) (\S+)/;
const UNKNOWN_FLAG = /unknown flag/i;

const activeAccountStatus = async (gh: GhRunner, cwd: string): Promise<GhResult> => {
  const result = await gh(cwd, ["auth", "status", "--active"]);
  if (result.exitCode !== 0 && UNKNOWN_FLAG.test(result.stderr)) return gh(cwd, ["auth", "status"]);
  return result;
};

export async function ghStatus(gh: GhRunner, cwd: string): Promise<GhStatus> {
  try {
    const result = await activeAccountStatus(gh, cwd);
    if (result.exitCode !== 0) return { kind: "signed-out" };
    return { kind: "connected", account: ACCOUNT.exec(`${result.stdout}\n${result.stderr}`)?.[1] };
  } catch (err) {
    if (err instanceof GhError) return { kind: "missing" };
    throw err;
  }
}
