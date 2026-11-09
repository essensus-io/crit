import { Box, Text, useStdout } from "ink";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

export type ScreenSize = { width: number; height: number };

export const MIN_WIDTH = 60;
export const MIN_HEIGHT = 16;

const Ctx = createContext<ScreenSize>({ width: 100, height: 30 });

/** The size every screen lays out in. Tests and non-TTY streams fall back to 100×30. */
export const useScreen = () => useContext(Ctx);

const read = (stdout: NodeJS.WriteStream): ScreenSize => {
  return { width: stdout.columns || 100, height: stdout.rows || 30 };
};
type Props = { children: ReactNode };

/**
 * The full-screen root. It is exactly as tall as the terminal and clips its
 * content, so nothing ever scrolls the terminal itself: anything longer than
 * the screen scrolls inside a Viewport.
 */
export const Screen = ({ children }: Props) => {
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const [size, setSize] = useState(() => read(stdout));
  useEffect(() => {
    const on = () => setSize(read(stdout));
    stdout.on("resize", on);
    return () => void stdout.off("resize", on);
  }, [stdout]);
  if (size.width < MIN_WIDTH || size.height < MIN_HEIGHT) {
    return (
      <Box width={size.width} height={size.height} overflow="hidden" flexDirection="column">
        <Text color="yellow">
          Terminal too small ({size.width}×{size.height}); crit needs {MIN_WIDTH}×{MIN_HEIGHT}.
        </Text>
        <Text dimColor>Resize the window, or press q to quit.</Text>
      </Box>
    );
  }
  return (
    <Ctx.Provider value={size}>
      <Box width={size.width} height={size.height} overflow="hidden" flexDirection="column">
        {children}
      </Box>
    </Ctx.Provider>
  );
};
