// Usage is measured in input-token equivalents of each client's reference model (Claude Opus 5.5,
// Codex GPT-6 Astra), weighting every token by its own model's published price, so sessions that mix
// a lead and cheaper workers compare correctly. Subscription meters are not published: Claude Code's
// docs say re-reads draw usage "at the cached token rate", and Codex's pricing page says model choice,
// caching and reasoning all affect usage, while credit prices alone don't fix included limits. Price-
// weighted tokens are therefore the comparison unit, not a quota estimate. Raw token totals are
// reported separately and are never the headline metric.

// Per million tokens: Claude in USD (platform.claude.com/docs/en/about-claude/pricing), Codex in
// credits at Standard speed (learn.chatgpt.com/docs/pricing), both checked 2026-10-22. Haiku 5.5 uses
// its rate for prompts up to 100k tokens. Codex has no cache-write charge.
const PRICES = {
  claude: [
    [/(fable|mythos)-5-1/, { input: 10, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 }],
    [/(fable|mythos)-5/, { input: 10, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 }],
    [/opus-5-5/, { input: 4, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, output: 20 }],
    [/opus-5/, { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 }],
    [/sonnet-5-5/, { input: 2, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 }],
    [/sonnet-5/, { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 }],
    [/haiku-5-5/, { input: 0.1, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2, output: 0.5 }],
  ],
  codex: [
    [/gpt-6-astra/, { input: 250, cacheRead: 25, output: 1250 }],
    [/gpt-6\.1-sol/, { input: 50, cacheRead: 2.5, output: 250 }],
    [/gpt-6-sol/, { input: 50, cacheRead: 5, output: 250 }],
    [/gpt-6-luna/, { input: 2.5, cacheRead: 0.25, output: 12.5 }],
    [/gpt-5\.6-sol/, { input: 100, cacheRead: 10, output: 500 }],
    [/gpt-5\.6-terra/, { input: 50, cacheRead: 5, output: 300 }],
    [/gpt-5\.6-luna/, { input: 5, cacheRead: 0.5, output: 30 }],
  ],
};
const REFERENCE = { claude: 'claude-opus-5-5', codex: 'gpt-6-astra' };
export const PRICE_UNIT = { claude: 'USD', codex: 'credits' };

// Models without a published price keep the client's usual token-type ratios at the reference price.
const FALLBACK = {
  claude: { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 },
  codex: { input: 1, cacheRead: 0.1, cacheWrite5m: 0, cacheWrite1h: 0, output: 5 },
};
const side = client => client === 'codex' ? 'codex' : 'claude';

export const price = (client, model = '') => PRICES[side(client)].find(([pattern]) => pattern.test(model))?.[1] || null;

export function weights(client, model) {
  const p = price(client, model), reference = price(client, REFERENCE[side(client)]).input;
  if (!p) return FALLBACK[side(client)];
  return { input: p.input / reference, cacheRead: p.cacheRead / reference, cacheWrite5m: (p.cacheWrite5m || 0) / reference, cacheWrite1h: (p.cacheWrite1h || 0) / reference, output: p.output / reference };
}

export const emptyCounts = () => ({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });

export function units(counts, client, model) {
  const w = weights(client, model);
  return Object.keys(emptyCounts()).reduce((sum, key) => sum + (counts[key] || 0) * w[key], 0);
}

// Published price of these tokens (USD for Claude, credits for Codex); null for an unpriced model.
export function cost(counts, client, model) {
  const p = price(client, model);
  return p ? Object.keys(emptyCounts()).reduce((sum, key) => sum + (counts[key] || 0) * (p[key] || 0), 0) / 1e6 : null;
}

// Per-part breakdown, so reports show where usage actually goes.
export function breakdown(counts, client, model) {
  const w = weights(client, model);
  return {
    reads: counts.cacheRead * w.cacheRead,
    writes: counts.cacheWrite5m * w.cacheWrite5m + counts.cacheWrite1h * w.cacheWrite1h,
    output: counts.output * w.output,
    input: counts.input * w.input,
  };
}

export const rawTokens = counts => Object.values(counts).reduce((a, b) => a + b, 0);
