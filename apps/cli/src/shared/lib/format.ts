export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m${String(s).padStart(2, "0")}s` : `${m}m`;
}

export function when(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(n) - day(d)) / 86_400_000);
  if (diffDays === 0) return `today ${hhmm}`;
  if (diffDays === 1) return `yesterday ${hhmm}`;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== n.getFullYear() ? { year: "numeric" } : {}),
  });
}

export const plural = (n: number, word: string, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;
