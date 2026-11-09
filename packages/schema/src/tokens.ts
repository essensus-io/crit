export const CACHE_DISCOUNT = 0.1;

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
});

export const addUsage = (tokenUsage: TokenUsage, b: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: tokenUsage.inputTokens + (b.inputTokens ?? 0),
  outputTokens: tokenUsage.outputTokens + (b.outputTokens ?? 0),
  cachedInputTokens: tokenUsage.cachedInputTokens + (b.cachedInputTokens ?? 0),
});

export function effectiveTokens(u: Partial<TokenUsage>): number {
  return Math.round(
    (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cachedInputTokens ?? 0) * CACHE_DISCOUNT,
  );
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}
