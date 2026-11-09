import { render } from "ink";
import type { ReactElement } from "react";
import { Screen } from "./index.ts";

const ALT_SCROLL_ON = "\u001B[?1007h";

const ALT_SCROLL_OFF = "\u001B[?1007l";

export const renderFullScreen = async (node: ReactElement): Promise<void> => {
  const tty = Boolean(process.stdout.isTTY);
  if (tty) process.stdout.write(ALT_SCROLL_ON);
  const app = render(<Screen>{node}</Screen>, { alternateScreen: true });
  try {
    await app.waitUntilExit();
  } finally {
    app.unmount();
    if (tty) process.stdout.write(ALT_SCROLL_OFF);
  }
};
