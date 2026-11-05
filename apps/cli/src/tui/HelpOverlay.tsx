import { Box, Text, useInput } from "ink";
import { T } from "./theme.ts";
import { Panel } from "./widgets.tsx";

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Review",
    rows: [
      ["j / k", "next / previous finding"],
      ["a", "accept the fix (a again undoes it); no fix → propose one"],
      ["d", "dismiss with a reason (d again restores)"],
      ["enter", "show or hide the full explanation, fix and thread"],
      ["A", "apply every accepted fix"],
    ],
  },
  {
    title: "Move around",
    rows: [
      ["↑ ↓ PgUp PgDn", "scroll the code"],
      ["h / l", "files list ⇄ code"],
      ["/", "search: words, sev:major, lens:security, file:cart, is:filtered"],
      ["g / G", "first / last finding"],
    ],
  },
  {
    title: "More",
    rows: [
      [".", "actions: propose, edit, ask, re-check, use my fix"],
      ["o", "options: model, provider, effort, depth, rules"],
      ["y", "copy this finding as a prompt for another agent"],
      ["R", "re-run the review of this scope (unchanged files come from the cache)"],
      ["q", "quit"],
    ],
  },
];

/** The cheat sheet: every key, grouped by what it is for. */
export function HelpOverlay({
  width,
  height,
  onClose,
}: {
  width: number;
  height: number;
  onClose: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || input === "q" || input === "?") onClose();
  });
  const w = Math.min(width - 2, 84);
  const rows = GROUPS.reduce((n, g) => n + g.rows.length + 1, 0);
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Panel title="keys" tone="lav" width={w} height={Math.min(height - 1, rows + 2)}>
        {GROUPS.map((g) => (
          <Box key={g.title} flexDirection="column">
            <Text color={T.orange} bold>
              {g.title}
            </Text>
            {g.rows.map(([k, label]) => (
              <Text key={k} wrap="truncate">
                {"  "}
                <Text bold color={T.cyan}>
                  {k.padEnd(14)}
                </Text>
                {label}
              </Text>
            ))}
          </Box>
        ))}
      </Panel>
      <Text dimColor> any of esc · q · ? closes</Text>
    </Box>
  );
}
