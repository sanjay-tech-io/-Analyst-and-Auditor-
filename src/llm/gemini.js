// Gemini wrapper. Every call is logged and its token usage/cost recorded automatically.
import { GoogleGenerativeAI } from '@google/generative-ai';
import { log, withLogging } from '../utils/logger.js';
import { computeCost } from '../utils/costTracker.js';

export const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
export const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';

let client;
function getClient() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
  client ??= new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client;
}

const isOverload = (err) => err.status === 429 || err.status >= 500;

// Retries rate-limit / overload errors (429, 5xx) with exponential backoff: 2s, 4s, 8s.
const MAX_RETRIES = 3;
async function withRetry(call, model) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!isOverload(err) || attempt >= MAX_RETRIES) throw err;
      const delayMs = 2000 * 2 ** attempt;
      log('llm.retry', { model, attempt: attempt + 1, status: err.status, delayMs });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function callModel(model, prompt, { system, json, schema }) {
  const m = getClient().getGenerativeModel({
    model,
    systemInstruction: system,
    generationConfig:
      json || schema ? { responseMimeType: 'application/json', responseSchema: schema } : undefined,
  });
  return m.generateContent(prompt);
}

/**
 * On overload the primary gets MAX_RETRIES retries, then FALLBACK_MODEL gets one attempt.
 * `fallbackFrom` is set on the result when the fallback served it, so agents can trace it.
 * @param {string} prompt
 * @param {{ model?: string, system?: string, json?: boolean, schema?: object, tracker?: import('../utils/costTracker.js').CostTracker }} opts
 * @returns {Promise<{ text: string, usage: object, model: string, fallbackFrom?: string }>}
 */
async function generateRaw(prompt, { model = DEFAULT_MODEL, tracker, ...opts } = {}) {
  let servedBy = model;
  let fallbackFrom;
  let res;
  try {
    res = await withRetry(() => callModel(model, prompt, opts), model);
  } catch (err) {
    if (!isOverload(err) || FALLBACK_MODEL === model) throw err;
    log('llm.model_fallback_triggered', { failedModel: model, status: err.status, fallbackModel: FALLBACK_MODEL });
    res = await callModel(FALLBACK_MODEL, prompt, opts); // throws as before if this fails too
    servedBy = FALLBACK_MODEL;
    fallbackFrom = model;
    log('llm.model_fallback_succeeded', { failedModel: model, servedBy });
  }

  const meta = res.response.usageMetadata ?? {};
  const input = meta.promptTokenCount ?? 0;
  // "Thinking" tokens are billed at the output rate.
  const output = (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
  // Price by the model that actually generated the tokens.
  const usage = tracker ? tracker.add(servedBy, input, output) : computeCost(servedBy, input, output);
  log('llm.usage', { model: servedBy, ...usage });
  return { text: res.response.text(), usage, model: servedBy, fallbackFrom };
}

export const generate = withLogging('llm', 'gemini.generate', generateRaw, {
  // The tracker is in-process state, not call context — keep it out of the log.
  logArgs: ([prompt, { tracker, ...opts } = {}]) => [prompt, opts],
});
