/** Keys in agent init events that describe the recording machine, not the protocol. */
const DROP_KEYS = new Set([
  "memory_paths",
  "messaging_socket_path",
  "plugins",
  "skills",
  "slash_commands",
  "terminal_slash_commands",
  "agents",
  "additional_directories",
  "analytics_disabled",
  "product_feedback_disabled",
]);

/**
 * Make a recorded transcript safe to commit: replace local paths with stable
 * placeholders and drop machine-specific keys. Non-JSON lines are kept as is.
 */
export function scrubTranscript(
  lines: string[],
  opts: { repo: string; home: string; extra?: string[]; user?: string },
): string[] {
  const replacements: [string, string][] = [
    [opts.repo, "/repo"],
    [opts.repo.replace(/^\/private/, ""), "/repo"],
    ...(opts.extra ?? []).flatMap((p): [string, string][] => [
      [p, "/tmp/crit"],
      [p.replace(/^\/private/, ""), "/tmp/crit"],
    ]),
    [opts.home, "~"],
  ];
  const userRe = opts.user
    ? new RegExp(`\\b${opts.user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g")
    : undefined;
  const fix = (s: string) => {
    const r = replacements.reduce((acc, [from, to]) => acc.split(from).join(to), s);
    return userRe ? r.replace(userRe, "user") : r;
  };
  return lines.map((line) => {
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      return fix(line);
    }
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return fix(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        return Object.fromEntries(
          Object.entries(v)
            .filter(([k]) => !DROP_KEYS.has(k))
            .map(([k, x]) => [k, walk(x)]),
        );
      }
      return v;
    };
    return JSON.stringify(walk(d));
  });
}
