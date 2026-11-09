import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type Editor = (content: string, filename: string) => Promise<string | undefined>;

export function terminalEditor(env: NodeJS.ProcessEnv): Editor {
  return async (content, filename) => {
    const dir = mkdtempSync(join(tmpdir(), "crit-edit-"));
    const file = join(dir, basename(filename));
    writeFileSync(file, content);
    try {
      const editor = env.VISUAL || env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
      const spawnSyncReturns = spawnSync(editor, [file], { stdio: "inherit", shell: true });
      if (spawnSyncReturns.status !== 0) return undefined;
      const edited = readFileSync(file, "utf8");
      return edited === content ? undefined : edited;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
