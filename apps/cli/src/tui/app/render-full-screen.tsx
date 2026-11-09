import { render } from "ink";
import type { ReactElement } from "react";
import { Screen } from "../shared/ui/index.ts";

const ALT_SCROLL_ON = "\u001B[?1007h";

const ALT_SCROLL_OFF = "\u001B[?1007l";

/**
 * Render full screen: the terminal's alternate buffer (its own scrollback is
 * untouched and comes back on exit), a root exactly as tall as the window, and
 * wheel scrolling delivered as arrow keys. Nothing scrolls the outer terminal.
 */
export async function renderFullScreen(node: ReactElement): Promise<void> {
  const tty = Boolean(process.stdout.isTTY);
  if (tty) process.stdout.write(ALT_SCROLL_ON);
  const app = render(<Screen>{node}</Screen>, { alternateScreen: true });
  try {
    await app.waitUntilExit();
  } finally {
    app.unmount();
    if (tty) process.stdout.write(ALT_SCROLL_OFF);
  }
}
