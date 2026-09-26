// Token → cost accounting. All prices are USD per 1M tokens.
//
// VERIFY BEFORE RELYING ON THESE: Gemini pricing changes often and differs by
// model, tier, and prompt length. Check https://ai.google.dev/gemini-api/docs/pricing
// Paid-tier text pricing, checked 2026-09-26. Thinking tokens bill at the output rate.
// Entries with `until` switch to their `after` prices once that promo window ends.
export const PRICING_USD_PER_1M = {
  'gemini-3.8-flash': {
    until: '2027-01-01', input: 0.75, output: 3.75,
    after: { input: 1.50, output: 7.50 },
  },
  'gemini-3.5-flash-lite': { input: 0.30, output: 2.50 },
};

function priceFor(model, now = new Date()) {
  const p = PRICING_USD_PER_1M[model];
  if (!p) throw new Error(`No pricing configured for model "${model}" — add it to PRICING_USD_PER_1M`);
  return p.until && now >= new Date(p.until) ? p.after : p;
}

// Override via env: USD_TO_INR=88.5
export const USD_TO_INR = Number(process.env.USD_TO_INR) || 88;

export function computeCost(model, inputTokens = 0, outputTokens = 0) {
  const price = priceFor(model);
  const usd = (inputTokens * price.input + outputTokens * price.output) / 1e6;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    usd,
    rupees: usd * USD_TO_INR,
  };
}

// Accumulates cost across all calls for one question.
export class CostTracker {
  constructor() {
    this.calls = [];
  }

  add(model, inputTokens, outputTokens) {
    const cost = computeCost(model, inputTokens, outputTokens);
    this.calls.push({ model, ...cost });
    return cost;
  }

  get totals() {
    return this.calls.reduce(
      (t, c) => ({
        inputTokens: t.inputTokens + c.inputTokens,
        outputTokens: t.outputTokens + c.outputTokens,
        totalTokens: t.totalTokens + c.totalTokens,
        usd: t.usd + c.usd,
        rupees: t.rupees + c.rupees,
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0, rupees: 0 },
    );
  }
}
