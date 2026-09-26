// Analyst agent: plan → memory check → parallel search → synthesis → cross-check → memory write.
// Every Gemini/Tavily call goes through the logged wrappers; every step is also a trace row.
import { SchemaType } from '@google/generative-ai';
import { generate } from '../llm/gemini.js';
import { webSearch } from '../tools/webSearch.js';
import { log } from '../utils/logger.js';
import { CostTracker } from '../utils/costTracker.js';

const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CROSS_CHECKS = 3; // bounds extra searches per question
const MAX_SOURCE_CHARS = 1500; // per source, keeps the synthesis prompt small
const MAX_FACTS_PER_ENTITY = 50; // oldest facts drop off first

// ---------- helpers ----------

// Writes a trace row and mirrors it into the session log so the log file alone tells the story.
function trace(ctx, stepType, content) {
  ctx.store.addTrace(ctx.questionId, stepType, content);
  log(`trace.${stepType}`, { questionId: ctx.questionId, content });
}

async function askJson(ctx, prompt, schema) {
  const { text, model, fallbackFrom } = await generate(prompt, { json: true, schema, tracker: ctx.tracker });
  if (fallbackFrom) trace(ctx, 'decision', { decision: 'model_fallback_triggered', failedModel: fallbackFrom, servedBy: model });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

// Lowercase words ≥4 chars plus any numbers — the bits a second source should repeat.
const keyTerms = (text) => new Set(text.toLowerCase().match(/\d[\d.,%]*|[a-z]{4,}/g) ?? []);

// ---------- steps ----------

async function plan(ctx, question) {
  const p = await askJson(ctx, `You are planning web research for the question below. Do not answer it.
Return JSON exactly in this shape:
{"subQuestions": string[], "entitiesToCheck": [{"name": string, "type": string}], "searchQueries": string[]}
- subQuestions: 2-5 smaller questions that together answer the main question.
- entitiesToCheck: specific named entities (companies, people, products, places, organisations) whose facts the answer depends on. "type" is a short lowercase noun such as "company" or "person".
- searchQueries: 2-5 specific web search queries. Include years or other qualifiers when the question is time-sensitive.

Question: ${question}`);

  const result = {
    subQuestions: p.subQuestions ?? [],
    entitiesToCheck: (p.entitiesToCheck ?? []).map((e) => (typeof e === 'string' ? { name: e, type: 'unknown' } : e)),
    searchQueries: p.searchQueries ?? [],
  };
  trace(ctx, 'plan', result);
  return result;
}

// Reuses an entity only if it was updated within FRESH_MS and still has facts learned within
// FRESH_MS, each with a real source URL. Older facts are left out rather than re-cited.
function checkMemory(ctx, entities) {
  const cached = [];
  const toSearch = [];
  for (const e of entities) {
    const row = ctx.store.getEntityByName(e.name);
    const ageMs = row ? Date.now() - Date.parse(row.last_updated.replace(' ', 'T') + 'Z') : Infinity;
    const all = Array.isArray(row?.data?.sources) ? row.data.sources : [];
    const facts = all.filter(
      (f) => f.fact && /^https?:\/\//i.test(f.sourceUrl) && Date.now() - Date.parse(f.learnedAt) < FRESH_MS,
    );

    if (ageMs < FRESH_MS && facts.length) {
      cached.push({ ...row, data: { sources: facts } });
      trace(ctx, 'memory_hit', {
        entity: row.name,
        type: row.type,
        ageHours: Math.round(ageMs / 36e5),
        facts: facts.length,
        staleFactsSkipped: all.length - facts.length,
        sourceUrls: [...new Set(facts.map((f) => f.sourceUrl))],
      });
    } else {
      toSearch.push(e);
      const reason = !row ? 'missing' : ageMs >= FRESH_MS ? 'stale' : 'no_sourced_facts';
      trace(ctx, 'decision', { decision: 'memory_miss', entity: e.name, reason });
    }
  }
  return { cached, toSearch };
}

// All queries fire at once. A failed search becomes an empty result instead of sinking the batch.
async function searchAll(ctx, queries, purpose) {
  for (const query of queries) trace(ctx, 'tool_call', { tool: 'webSearch', purpose, query });
  const batch = await Promise.all(
    queries.map((query) =>
      webSearch(query).then(
        (results) => ({ query, results }),
        (err) => ({ query, results: [], error: err.message }),
      ),
    ),
  );
  for (const { query, results, error } of batch) {
    trace(ctx, 'tool_result', { tool: 'webSearch', purpose, query, error, urls: results.map((r) => r.url) });
  }
  return batch;
}

async function synthesize(ctx, question, planResult, sources) {
  const evidence = sources
    .map((s, i) => `[S${i + 1}] ${s.title}\nURL: ${s.url}\n${s.content.slice(0, MAX_SOURCE_CHARS)}`)
    .join('\n\n');

  return askJson(ctx, synthesisPrompt(question, planResult, evidence), SYNTHESIS_SCHEMA);
}

// Enforced by the API, not just requested: memory needs one sourceUrl per fact.
const str = { type: SchemaType.STRING };
const SYNTHESIS_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    answer: str,
    claims: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: { text: str, citedUrl: str, supportingUrls: { type: SchemaType.ARRAY, items: str } },
        required: ['text', 'citedUrl', 'supportingUrls'],
      },
    },
    entitiesLearned: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: str,
          type: str,
          facts: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: { fact: str, sourceUrl: str },
              required: ['fact', 'sourceUrl'],
            },
          },
        },
        required: ['name', 'type', 'facts'],
      },
    },
    unableToFind: { type: SchemaType.ARRAY, items: str },
  },
  required: ['answer', 'claims', 'entitiesLearned', 'unableToFind'],
};

function synthesisPrompt(question, planResult, evidence) {
  return `Answer the research question using ONLY the evidence below.
Rules:
- Every claim must be directly stated by a source. "citedUrl" is the URL of the best source for it; "supportingUrls" lists EVERY source URL that states it (including citedUrl).
- If the evidence does not answer something the question asks, put it in "unableToFind". Never fill gaps from your own knowledge and never guess.
- "entitiesLearned": named entities with facts established by the evidence. Each fact is one short, self-contained statement (e.g. "CEO and MD of Infosys since 2 January 2018") with "sourceUrl" set to the URL of the one source that states it. Sources headed "Previously learned" are facts from earlier research — cite their URL like any other source.
- "answer" summarises only what the claims support.

Return JSON exactly in this shape:
{"answer": string, "claims": [{"text": string, "citedUrl": string, "supportingUrls": string[]}], "entitiesLearned": [{"name": string, "type": string, "facts": [{"fact": string, "sourceUrl": string}]}], "unableToFind": string[]}

Question: ${question}
Sub-questions to cover:
${planResult.subQuestions.map((q) => `- ${q}`).join('\n')}

Evidence:
${evidence}`;
}

// Claims backed by one domain get a targeted search for a second, independent source.
// Corroboration is a keyword-overlap heuristic, not semantic verification — the auditor's job.
export async function crossCheck(ctx, claims) {
  const single = [];
  for (const claim of claims) {
    if (claim.citedUrl.startsWith('memory:')) {
      claim.corroboration = 'memory';
      continue;
    }
    const domains = new Set([claim.citedUrl, ...(claim.supportingUrls ?? [])].map(domainOf));
    if (domains.size > 1) {
      claim.corroboration = 'multi_source';
      continue;
    }
    claim.corroboration = 'single_source';
    const action = single.length < MAX_CROSS_CHECKS ? 'targeted_search' : 'skipped_cap_reached';
    trace(ctx, 'decision', { decision: 'single_source_claim_detected', claim: claim.text, citedUrl: claim.citedUrl, action });
    if (action === 'targeted_search') single.push(claim);
  }
  if (!single.length) return;

  const batch = await searchAll(ctx, single.map((c) => c.text.slice(0, 200)), 'cross_check');
  single.forEach((claim, i) => {
    const terms = keyTerms(claim.text);
    const second = batch[i].results.find((r) => {
      if (domainOf(r.url) === domainOf(claim.citedUrl)) return false;
      const hay = `${r.title} ${r.content}`.toLowerCase();
      const hits = [...terms].filter((t) => hay.includes(t)).length;
      return terms.size && hits / terms.size >= 0.6;
    });
    if (second) {
      claim.corroboration = 'possible_second_source'; // keyword match only — auditor must confirm
      claim.secondaryUrl = second.url;
    }
    trace(ctx, 'decision', {
      decision: 'cross_check_result', method: 'keyword_overlap', claim: claim.text,
      possibleSecondSource: !!second, secondaryUrl: second?.url,
    });
  });
}

// Entity data shape: { sources: [{ fact, sourceUrl, learnedAt }] }, newest first.
// Each fact keeps the page it was learned from, so later reuse can cite that page directly.
const factKey = (f) => `${f.fact.trim().toLowerCase()}|${f.sourceUrl}`;

// Cached facts join the evidence under their ORIGINAL page URL (merged with that page's fresh
// search result if it came back again). A claim built on one fact then cites only that fact's
// page — a real URL the auditor can fetch, never a "memory:" placeholder.
function addMemoryEvidence(cached, byUrl) {
  const byPage = new Map();
  for (const e of cached) {
    for (const f of e.data.sources) {
      const page = byPage.get(f.sourceUrl) ?? { lines: [], learnedAt: f.learnedAt };
      page.lines.push(`- ${e.name}: ${f.fact}`);
      if (f.learnedAt < page.learnedAt) page.learnedAt = f.learnedAt;
      byPage.set(f.sourceUrl, page);
    }
  }
  for (const [url, { lines, learnedAt }] of byPage) {
    const header = `Previously learned from this page (${learnedAt.slice(0, 10)}):\n${lines.join('\n')}`;
    const fresh = byUrl.get(url);
    byUrl.set(url, fresh
      // Memory lines go first so the per-source truncation in synthesize() can't cut them off.
      ? { ...fresh, content: `${header}\n\n${fresh.content}` }
      : { url, title: 'Previously learned', content: header, memoryOnly: true, learnedAt });
  }
}

function writeMemory(ctx, entities, byUrl) {
  const written = [];
  for (const e of entities) {
    if (!e?.name) continue;
    const type = (e.type || 'unknown').toLowerCase(); // "Person" and "person" are one key
    const existing = ctx.store.getEntity(e.name, type)?.data?.sources ?? [];
    const existingByKey = new Map(existing.map((f) => [factKey(f), f]));

    const incoming = [];
    for (const f of e.facts ?? []) {
      const source = byUrl.get(f?.sourceUrl);
      if (!f?.fact || !source || !/^https?:\/\//i.test(f.sourceUrl)) {
        trace(ctx, 'decision', { decision: 'memory_fact_rejected', entity: e.name, fact: f?.fact, sourceUrl: f?.sourceUrl, reason: 'source not in this run\'s evidence' });
        continue;
      }
      const fact = { fact: String(f.fact).trim(), sourceUrl: f.sourceUrl };
      // A fact restated from memory keeps its original learnedAt — it wasn't re-read today.
      const learnedAt = source.memoryOnly
        ? (existingByKey.get(factKey(fact))?.learnedAt ?? source.learnedAt)
        : new Date().toISOString();
      incoming.push({ ...fact, learnedAt, fromFreshPage: !source.memoryOnly });
    }

    // Only a fact read off a freshly retrieved page justifies bumping last_updated;
    // otherwise memory would keep renewing itself and never go stale.
    if (!incoming.some((f) => f.fromFreshPage)) continue;

    const seen = new Set(incoming.map(factKey));
    const sources = [
      ...incoming.map(({ fromFreshPage, ...f }) => f),
      ...existing.filter((f) => !seen.has(factKey(f))),
    ].slice(0, MAX_FACTS_PER_ENTITY);
    ctx.store.upsertEntity(e.name, type, { sources });
    written.push({ entity: e.name, type, newFacts: incoming.filter((f) => f.fromFreshPage).length, totalFacts: sources.length });
  }
  trace(ctx, 'decision', { decision: 'memory_write', entities: written });
}

// ---------- entry point ----------

/**
 * @param {string} question
 * @param {{ store: ReturnType<import('../memory/db.js').createStore> }} deps
 */
export async function runAnalyst(question, { store }) {
  const started = Date.now();
  const ctx = { store, tracker: new CostTracker(), questionId: store.startQuestion(question) };
  log('question.start', { questionId: ctx.questionId, question });

  let result = null;
  try {
    const planResult = await plan(ctx, question);
    const { cached, toSearch } = checkMemory(ctx, planResult.entitiesToCheck);

    const queries = [...new Set([...planResult.searchQueries, ...toSearch.map((e) => `${e.name} ${e.type}`)])];
    const batch = await searchAll(ctx, queries, 'research');

    // Dedupe by URL; cached facts are filed under the page they came from.
    const byUrl = new Map();
    for (const r of batch.flatMap((b) => b.results)) if (!byUrl.has(r.url)) byUrl.set(r.url, r);
    addMemoryEvidence(cached, byUrl);
    const sources = [...byUrl.values()];

    const draft = await synthesize(ctx, question, planResult, sources);
    result = {
      answer: draft.answer ?? '',
      claims: [],
      entitiesLearned: draft.entitiesLearned ?? [],
      unableToFind: draft.unableToFind ?? [],
    };

    // A claim citing a URL we never retrieved is a fabricated citation — refuse it.
    for (const claim of draft.claims ?? []) {
      if (byUrl.has(claim.citedUrl)) {
        claim.supportingUrls = (claim.supportingUrls ?? []).filter((u) => byUrl.has(u));
        if (byUrl.get(claim.citedUrl).memoryOnly) {
          claim.fromMemory = true; // cites the original page; not re-read this run
          trace(ctx, 'decision', { decision: 'memory_fact_cited', claim: claim.text, citedUrl: claim.citedUrl });
        }
        result.claims.push(claim);
      } else {
        trace(ctx, 'decision', { decision: 'uncited_claim_rejected', claim: claim.text, citedUrl: claim.citedUrl });
        result.unableToFind.push(`Unverified (no retrieved source): ${claim.text}`);
      }
    }
    trace(ctx, 'decision', {
      decision: 'synthesis_complete',
      claims: result.claims.length,
      unableToFind: result.unableToFind.length,
    });

    await crossCheck(ctx, result.claims);
    writeMemory(ctx, result.entitiesLearned, byUrl);
    return result;
  } finally {
    // Runs on failure too, so partial spend is never lost.
    const cost = ctx.tracker.totals;
    const durationMs = Date.now() - started;
    store.finishQuestion(ctx.questionId, {
      answer: result && JSON.stringify(result),
      costTokens: cost.totalTokens,
      costRupees: cost.rupees,
      durationMs,
    });
    log('question.cost', {
      questionId: ctx.questionId,
      llmCalls: ctx.tracker.calls.length,
      ...cost,
      durationMs,
      status: result ? 'ok' : 'failed',
    });
    if (result) Object.assign(result, { questionId: ctx.questionId, cost, durationMs });
  }
}
