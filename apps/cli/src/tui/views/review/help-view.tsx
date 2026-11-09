import { Box, Text, useInput } from "ink";
import { T } from "../../shared/lib/index.ts";
import { Panel } from "../../shared/ui/index.ts";

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Review",
    rows: [
      ["j / k  ↑ ↓", "next / previous finding"],
      ["space", "check the fix to apply it (again to uncheck; unchecked fixes are left alone)"],
      ["i", "propose your fix: tell the AI what it should be, then check it or not"],
      ["enter", "apply every checked fix, once you have been through all findings"],
      ["x", "apply just this fix now"],
      ["d", "skip: dismiss with a reason (again restores). Unticked = left alone"],
    ],
  },
  {
    title: "Move around",
    rows: [
      ["PgUp PgDn", "scroll the code (↑ ↓ move between findings, like j / k)"],
      ["tab / ]", "next file (shift-tab or [ for the previous)"],
      ["h / l", "files list ⇄ code; in the list j/k jump between files"],
      ["/", "search: words, sev:major, lens:security, file:cart, has:fix, is:pending, is:filtered"],
      ["g", "first finding"],
    ],
  },
  {
    title: "More",
    rows: [
      [".", "actions: propose, edit, ask, re-check, use my fix"],
      ["o", "options: model, provider (add or remove a setup), effort, depth, rules"],
      ["y", "copy this finding as a prompt for another agent"],
      ["r", "re-run the review of this scope, without the cache"],
      ["q", "back to the start screen (quit when opened with crit open)"],
    ],
  },
];
type Props = {
  width: number;
  height: number;
  onClose: () => void;
};

/** The cheat sheet: every key, grouped by what it is for. */
export const HelpView = ({ width, height, onClose }: Props) => {
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
};
