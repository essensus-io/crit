import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { T } from "./theme.ts";

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  go,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  html: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  mdx: "markdown",
  sql: "sql",
};

/** A piece of one line with its color. */
export type Tok = { t: string; color?: string };

/** The language for a file name, or undefined when crit has no grammar for it. */
export function languageOf(file: string): string | undefined {
  const ext = file.split(".").pop()?.toLowerCase();
  return ext && file.includes(".") ? BY_EXTENSION[ext] : undefined;
}

// Token colors from the palette; anything not listed stays the default text color.
const COLORS: [RegExp, string][] = [
  [/^hljs-(comment|quote|doctag)/, T.gray],
  [/^hljs-(keyword|selector-tag|meta-keyword)/, T.lav],
  [/^hljs-(string|regexp|template-variable|addition)/, T.mint],
  [/^hljs-(number|literal|symbol|bullet)/, T.orange],
  [/^hljs-(title|function|section|name|selector-id|selector-class)/, T.cyan],
  [/^hljs-(built_in|type|class|attr|attribute|property|tag)/, T.yellow],
  [/^hljs-(meta|variable|params)/, T.cyan],
  [/^hljs-(deletion)/, T.red],
];
const colorOf = (cls: string): string | undefined => {
  for (const c of cls.split(/\s+/)) for (const [re, color] of COLORS) if (re.test(c)) return color;
  return undefined;
};

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
};
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m);

/** highlight.js HTML to colored pieces per line; a token that spans lines keeps its color on each. */
function toLines(html: string): Tok[][] {
  const lines: Tok[][] = [[]];
  const stack: (string | undefined)[] = [];
  const color = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i];
    return undefined;
  };
  for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
    if (part.startsWith("<span")) stack.push(colorOf(/class="([^"]*)"/.exec(part)![1]!));
    else if (part === "</span>") stack.pop();
    else if (part) {
      const text = decode(part);
      text.split("\n").forEach((piece, i) => {
        if (i > 0) lines.push([]);
        if (piece) lines.at(-1)!.push({ t: piece, ...(color() ? { color: color()! } : {}) });
      });
    }
  }
  return lines;
}

const MAX_LINES = 4000;

/**
 * Colors for every line of a file, highlighted as one document so strings and
 * comments that span lines come out right. Undefined for unknown languages and
 * very large files (the caller shows plain text).
 */
export function highlightFile(file: string, lines: string[]): Tok[][] | undefined {
  const language = languageOf(file);
  if (!language || lines.length > MAX_LINES) return undefined;
  try {
    const out = toLines(
      hljs.highlight(lines.map((l) => l.replace(/\t/g, "  ")).join("\n"), {
        language,
        ignoreIllegals: true,
      }).value,
    );
    // Same number of lines as the source, so a line number indexes the result.
    while (out.length < lines.length) out.push([]);
    return out.slice(0, lines.length);
  } catch {
    return undefined;
  }
}

/** One line on its own (fix patches); no state carries over from other lines. */
export function highlightLine(file: string | undefined, line: string): Tok[] {
  const language = file ? languageOf(file) : undefined;
  if (!language) return [{ t: line }];
  try {
    return (
      toLines(
        hljs.highlight(line.replace(/\t/g, "  "), { language, ignoreIllegals: true }).value,
      )[0] ?? [{ t: line }]
    );
  } catch {
    return [{ t: line }];
  }
}

/** Clip pieces to `n` characters, ending with an ellipsis when cut. */
export function clipToks(toks: Tok[], n: number): Tok[] {
  const out: Tok[] = [];
  let left = n;
  const total = toks.reduce((a, t) => a + t.t.length, 0);
  const limit = total > n ? n - 1 : n;
  left = limit;
  for (const tok of toks) {
    if (left <= 0) break;
    out.push(tok.t.length <= left ? tok : { ...tok, t: tok.t.slice(0, left) });
    left -= tok.t.length;
  }
  if (total > n) out.push({ t: "…" });
  return out;
}
