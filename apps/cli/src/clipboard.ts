import { spawnSync } from "node:child_process";

const TOOLS: [string, string[]][] = [
  ["pbcopy", []],
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
  ["xsel", ["--clipboard", "--input"]],
  ["clip", []],
];

/**
 * Copy text to the system clipboard. Falls back to the terminal's OSC 52
 * sequence, which works over ssh in most modern terminals. Returns how it was copied.
 */
export function copyToClipboard(
  text: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
): string {
  for (const [cmd, args] of TOOLS) {
    const r = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (!r.error && r.status === 0) return cmd;
  }
  write(`\u001B]52;c;${Buffer.from(text).toString("base64")}\u0007`);
  return "terminal (OSC 52)";
}
