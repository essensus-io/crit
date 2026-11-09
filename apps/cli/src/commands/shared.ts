import { repoRoot } from "@crit/core";
import { CliError } from "../shared/lib/index.ts";

export async function repoRootOrThrow(cwd: string): Promise<string> {
  try {
    return await repoRoot(cwd);
  } catch {
    throw new CliError("crit: not inside a git repository", {
      hint: "cd into a repository, or run `git init` first.",
    });
  }
}
