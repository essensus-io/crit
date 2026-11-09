import { describe, expect, it } from "vitest";
import { copyToClipboard } from "@/shared/lib/clipboard.ts";

describe("copyToClipboard", () => {
  it("returns how it copied; without a clipboard tool it falls back to an OSC 52 sequence", () => {
    const written: string[] = [];
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const via = copyToClipboard("héllo", (s) => written.push(s));
      expect(via).toBe("terminal (OSC 52)");
      expect(written[0]).toBe(`\u001B]52;c;${Buffer.from("héllo").toString("base64")}\u0007`);
    } finally {
      process.env.PATH = saved;
    }
  });
});
