import { describe, expect, it } from "vitest";
import { clipToks, highlightFile, highlightLine, languageOf } from "../src/shared/lib/highlight.ts";
import { T } from "../src/shared/lib/theme.ts";

const colorOfText = (line: { t: string; color?: string }[], text: string) =>
  line.find((k) => k.t.includes(text))?.color;

describe("highlight", () => {
  it("knows languages by extension and nothing else", () => {
    expect(languageOf("src/a.tsx")).toBe("typescript");
    expect(languageOf("a/b.py")).toBe("python");
    expect(languageOf("Makefile")).toBeUndefined();
    expect(languageOf("notes.xyz")).toBeUndefined();
  });

  it("colors keywords, strings, numbers and comments from the palette", () => {
    const lines = highlightFile("a.ts", ["const answer = 42; // the answer", 'const s = "hi";'])!;
    expect(lines).toHaveLength(2);
    expect(colorOfText(lines[0]!, "const")).toBe(T.lav);
    expect(colorOfText(lines[0]!, "42")).toBe(T.orange);
    expect(colorOfText(lines[0]!, "// the answer")).toBe(T.gray);
    expect(colorOfText(lines[1]!, '"hi"')).toBe(T.mint);
    expect(lines[0]!.map((k) => k.t).join("")).toBe("const answer = 42; // the answer");
  });

  it("keeps the color of a token that spans lines, and one output line per input line", () => {
    const src = ["/* first", "   second */", "let x = 1;", ""];
    const lines = highlightFile("a.js", src)!;
    expect(lines).toHaveLength(4);
    expect(colorOfText(lines[0]!, "first")).toBe(T.gray);
    expect(colorOfText(lines[1]!, "second")).toBe(T.gray);
    expect(colorOfText(lines[2]!, "let")).toBe(T.lav);
    expect(lines[3]).toEqual([]);
  });

  it("decodes HTML entities and turns tabs into spaces", () => {
    const lines = highlightFile("a.ts", ["if (a < b && c > d) {\treturn '&';"])!;
    expect(lines[0]!.map((k) => k.t).join("")).toBe("if (a < b && c > d) {  return '&';");
  });

  it("highlights big files (a 5000-line service) and falls back to plain text only for huge ones", () => {
    expect(
      highlightFile(
        "a.ts",
        Array.from({ length: 5000 }, () => "const x = 1;"),
      ),
    ).toHaveLength(5000);
    expect(highlightFile("a.xyz", ["x"])).toBeUndefined();
    expect(
      highlightFile(
        "a.ts",
        Array.from({ length: 20_001 }, () => "x"),
      ),
    ).toBeUndefined();
    expect(highlightLine(undefined, "plain")).toEqual([{ t: "plain" }]);
    expect(highlightLine("a.ts", "return 1;")[0]).toMatchObject({ t: "return", color: T.lav });
  });

  it("clipToks cuts across pieces and marks the cut", () => {
    const toks = [{ t: "const", color: T.lav }, { t: " value = 1" }];
    expect(clipToks(toks, 40)).toEqual(toks);
    const cut = clipToks(toks, 8);
    expect(cut.map((k) => k.t).join("")).toBe("const v…");
    expect(cut[0]).toEqual({ t: "const", color: T.lav });
  });
});
