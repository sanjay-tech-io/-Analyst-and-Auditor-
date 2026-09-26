# DECISIONS.md

## Architecture

Two independent agents, Node.js, no framework:
- **Analyst** (src/agents/analyst.js): plans before searching (structured Gemini
  call → sub-questions, entities to check, search queries), checks SQLite memory
  for known entities before searching, fires all searches concurrently
  (Promise.all), runs a lightweight single-source cross-check, synthesizes a
  structured answer with citations, writes learned facts back to memory.
- **Auditor** (src/agents/auditor.js): takes an analyst answer, independently
  re-fetches every cited URL, and asks Gemini — with a deliberately skeptical
  prompt — whether the page actually supports, contradicts, or is silent on
  each specific claim. Runs entirely separately from the analyst's own
  cross-check logic, by design, so it isn't inheriting the analyst's blind spots.

Stack: Gemini API (LLM), Tavily (search, no fallback) with direct-fetch
fallback for page fetching only (auditor), SQLite/better-sqlite3 (memory,
traces, cost tracking, audit reports), JSON-lines logs in logs/, plain
async functions, CLI-driven.

**Rejected:** Postgres/Supabase — no functional requirement calls for it, and
it adds a network dependency and provisioning step that works against the
five-minute clean-machine setup requirement, for zero benefit on a single-process
agent system with modest data volume. Also rejected: reusing the analyst's
cross-check logic inside the auditor — the auditor's value is being *independent*.

## Trade-offs under the time limit

- Cross-check on the analyst side is a weak, fast keyword-overlap signal, not
  a real verification step — real verification was deliberately pushed
  entirely to the auditor rather than trusted from the analyst's own weaker
  signal. This was validated with a hand-built test claim ("the moon is made
  of green cheese"): the cross-check counted a Wikipedia article about the
  myth as a second source for it — topical overlap, not actual support.
- Memory keys off explicitly named entities in a question, not semantic
  question similarity — cheap to build, but means a repeat question can
  miss facts it already has if they were filed under a different entity
  (see "Where it breaks", #1).
- Batch runner processes questions sequentially with a 5s pause, trading
  throughput for avoiding per-minute Gemini rate limits.

## Testing

Ran `npm run report -- 15,16,17,19,20,21,28,29,30,31,32,33` — 12 real,
non-mocked questions run end-to-end (analyst + audit) against live Gemini +
Tavily. Excluded: Q14 (mocked search), Q18 (forced failure test), Q22 (an
earlier run of the Zepto question, superseded by Q29), Q23 and Q27 (failed
runs, superseded by later successful runs of the same questions), and Q24,
Q25, Q26 (saved with unresolved template placeholders). Total cost ₹8.97
(analyst + audit), average ₹0.75 per question (full breakdown in
report.csv). Of 36 claims audited, 34 were supported, 2 unsupported, 0
contradicted. Average cost per question for the last six vs the first six:
−9% total, −7% analyst-only. The two halves ask different questions, so
this isn't a controlled measure of memory (see "Where it breaks", #1).
Questions span CEO/founder lookups, funding lists, retailer comparisons,
and a refusal test ("which company has never raised funding" — correctly
answered that there is no mention of such a company in the evidence it
gathered, rather than guessing one).

Separately: a 7-claim adversarial set built by hand to stress-test the
auditor (a false claim, a contradicted fact, a true claim, an uncited claim,
a dead URL, an unfetchable memory-style citation, plus the green-cheese
case above). First run: 2 of 7 came back wrong — two correct Infosys facts
were marked unsupported due to a bug in the quote-matching check (markdown
links and Wikipedia footnotes weren't stripped before comparison). After
fixing that, 7/7 verdicts were correct. A batch-runner failure path was also
verified by forcing one question to fail deliberately mid-batch; the run
continued and recorded the real partial spend rather than reporting zero.

## Where it breaks

1. **A repeat question can miss memory it actually has.** Asking "Who is the
   CEO of Wipro?" twice back-to-back cost ₹0.348 then ₹0.432 — the second
   run didn't reuse anything, even though the planner named Wipro as an
   entity to check in both runs. The cause: the first run filed both learned
   facts under "Srini Pallia" (the CEO), not "Wipro" (the company), because
   that's the entity the model chose when saving. The repeat question looks
   up "Wipro" and finds nothing there. Separately, even on a genuine memory
   hit (Q19, Q28, Q31), cost doesn't fall much: the planner's own search
   queries still run regardless of what memory returns, and remembered facts
   only add tokens to the final synthesis call. A hit saves just the extra
   entity-lookup search — it can't make a repeat question meaningfully
   cheaper by itself. The matching fix is to save each learned fact under
   every entity it mentions (not only the one the model happened to pick),
   and to let a genuine memory hit skip the searches it makes redundant —
   a more direct target than switching to semantic question matching.
2. **No fact invalidation across time.** One question stated Yash Dayal is
   Zepto's *current* head of engineering; the very next question about him
   surfaced that he'd left for Wakefit as CTO in mid-2023. The analyst
   self-corrected in the later answer, but the earlier claim, audited in
   isolation, would still verify as "supported" against its own citation —
   nothing re-checks or expires a fact once a later run learns something
   that contradicts it.
3. **Auditor verifies primary citations only.** When the analyst attaches a
   weak "possible second source" as loose corroboration, the auditor never
   independently opens that secondary page. A bad corroboration match (e.g.
   a same-named person at a different company) could go unchecked as long
   as the primary source happens to hold up.
4. **Model availability churn.** `gemini-2.5-flash` failed on its very first
   live call with a 404 ("no longer available to new users") — not a
   mid-build retirement, it was simply unavailable from the start. The
   replacement model returns 503/429 under load regularly; handled with
   retry-with-backoff (2s/4s/8s) then a model fallback, logged distinctly,
   but not eliminated.

## Next, with two more weeks

- Fact invalidation: when a new fact about a stored entity contradicts an
  existing one, flag or supersede it instead of letting both sit silently.
- Extend the auditor to verify secondary/corroborating URLs, not just the
  primary citation.
- Save each learned fact under every entity it mentions, not just the one
  the model files it under, and skip the searches a memory hit makes
  redundant — this directly targets the Wipro-style miss and the
  searches-still-run cost floor described in "Where it breaks", #1.
- Replace the analyst's keyword-overlap cross-check with an embedding-based
  signal, or drop it as a displayed signal entirely and rely solely on the
  auditor for corroboration.
- Load-test the pipeline under multiple simultaneous questions (not just
  parallel tool calls within one question) to find real concurrency limits.
