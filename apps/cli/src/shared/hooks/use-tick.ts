import { useEffect, useState } from "react";

export function useTick(ms = 150, active = true): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms, active]);
  return n;
}
