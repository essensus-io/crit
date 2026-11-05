/** Cached input is billed and rate-limited at a fraction of fresh input. */
export const CACHE_DISCOUNT = 0.1;

export type TokenUsage = {
  /** Fresh (uncached) input tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens: number;
};

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
});

export const addUsage = (a: TokenUsage, b: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: a.inputTokens + (b.inputTokens ?? 0),
  outputTokens: a.outputTokens + (b.outputTokens ?? 0),
  cachedInputTokens: a.cachedInputTokens + (b.cachedInputTokens ?? 0),
});

/**
 * What a run really costs against a budget: fresh input plus output, with
 * cached input counted at a tenth. Raw "input tokens" overstate cost because
 * agents resend their context every turn and most of it is served from cache.
 */
export function effectiveTokens(u: Partial<TokenUsage>): number {
  return Math.round(
    (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cachedInputTokens ?? 0) * CACHE_DISCOUNT,
  );
}

/** "812k", "1.2M", "950" */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}
