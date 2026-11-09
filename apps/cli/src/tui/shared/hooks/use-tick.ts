import { useEffect, useState } from "react";

/** Re-render every `ms` while `active`, for spinners and flowing connectors. */
export function useTick(ms = 150, active = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms, active]);
  return n;
}
