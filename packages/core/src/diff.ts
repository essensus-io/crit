import type { Hunk } from "@crit/schema";

export type ParsedHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  /** Body lines including their ' ', '+', '-' or '\' prefix. */
  body: string[];
};

export type ParsedFile = {
  oldPath: string | null;
  newPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  hunks: ParsedHunk[];
  text: string;
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(p: string): string | null {
  const bare = p.replace(/\t.*$/, "");
  if (bare === "/dev/null") return null;
  const unq: string = bare.startsWith('"') && bare.endsWith('"') ? JSON.parse(bare) : bare;
  return unq.replace(/^[ab]\//, "");
}

/**
 * Parse a unified diff (git or plain). Handles adds, deletes, renames, binary
 * markers and "\ No newline at end of file". Lines are split on \n only;
 * CRLF content keeps its \r.
 */
export function parseUnifiedDiff(diff: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let cur: (ParsedFile & { start: number }) | undefined;
  let hunk: ParsedHunk | undefined;
  let remainingOld = 0;
  let remainingNew = 0;

  const finish = (end: number) => {
    if (!cur) return;
    cur.text = `${lines.slice(cur.start, end).join("\n")}\n`;
    const { start: _s, ...file } = cur;
    if (
      file.status === "modified" &&
      file.oldPath &&
      file.newPath &&
      file.oldPath !== file.newPath
    ) {
      file.status = "renamed";
    }
    files.push(file);
    cur = undefined;
  };
  const begin = (i: number) => {
    finish(i);
    cur = {
      oldPath: null,
      newPath: null,
      status: "modified",
      binary: false,
      hunks: [],
      text: "",
      start: i,
    };
    hunk = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (hunk && (remainingOld > 0 || remainingNew > 0)) {
      const c = line[0];
      if (c === " " || c === "" || c === undefined) {
        remainingOld--;
        remainingNew--;
      } else if (c === "-") remainingOld--;
      else if (c === "+") remainingNew--;
      else if (c !== "\\") {
        // Malformed / truncated hunk: stop consuming body lines.
        hunk = undefined;
        i--;
        continue;
      }
      hunk.body.push(line);
      continue;
    }
    if (hunk && line.startsWith("\\")) {
      hunk.body.push(line);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      begin(i);
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      if (m) {
        cur!.oldPath = m[1]!;
        cur!.newPath = m[2]!;
      }
      continue;
    }
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      if (!cur || cur.hunks.length > 0) begin(i);
      cur!.oldPath = stripPrefix(line.slice(4));
      cur!.newPath = stripPrefix(lines[i + 1]!.slice(4));
      if (cur!.oldPath === null) cur!.status = "added";
      if (cur!.newPath === null) cur!.status = "deleted";
      i++;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename from ")) {
      cur.oldPath = line.slice(12);
      cur.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      cur.newPath = line.slice(10);
      cur.status = "renamed";
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.binary = true;
    else {
      const m = HUNK_RE.exec(line);
      if (m) {
        hunk = {
          oldStart: Number(m[1]),
          oldLines: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === undefined ? 1 : Number(m[4]),
          header: line,
          body: [],
        };
        remainingOld = hunk.oldLines;
        remainingNew = hunk.newLines;
        cur.hunks.push(hunk);
      }
    }
  }
  finish(lines.length);
  for (const f of files) {
    if (f.status === "added") f.oldPath = null;
    if (f.status === "deleted") f.newPath = null;
  }
  return files;
}

/** Path a file diff applies to: the new path, or the old one for deletions. */
export const diffPath = (f: ParsedFile): string => (f.newPath ?? f.oldPath)!;

/** New-file line ranges touched by a file diff. */
export function hunksOf(f: ParsedFile): Hunk[] {
  return f.hunks.map((h) => ({ start: h.newStart, lines: h.newLines }));
}

/** Lines (1-based, new side) that a file diff adds. */
export function addedLines(f: ParsedFile): Set<number> {
  const out = new Set<number>();
  for (const h of f.hunks) {
    let n = h.newStart;
    for (const l of h.body) {
      if (l.startsWith("+")) out.add(n++);
      else if (l.startsWith(" ") || l === "") n++;
    }
  }
  return out;
}
