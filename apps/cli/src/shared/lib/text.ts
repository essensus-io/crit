export const truncate = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;

export function wrapText(text: string, width: number): string[] {
  const w = Math.max(10, width);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    const indent = /^\s*/.exec(para)![0];
    let line = "";
    for (let word of para.trim().split(/\s+/)) {
      while (word.length > w) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(indent + word.slice(0, w - indent.length));
        word = word.slice(w - indent.length);
      }
      if (!line) line = indent + word;
      else if (line.length + 1 + word.length <= w) line += ` ${word}`;
      else {
        out.push(line);
        line = indent + word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}
