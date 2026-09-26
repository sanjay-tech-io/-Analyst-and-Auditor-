# analyst-auditor

Two LLM agents for open research questions. The **analyst** plans a question, checks its
SQLite memory for known entities, runs web searches in parallel (Tavily), and answers with a
citation for every claim — anything it can't source goes in `unableToFind` instead of being
guessed. The **auditor** then independently fetches each cited page and asks Gemini whether that
page actually supports, contradicts, or says nothing about the specific claim. Every LLM and
tool call is logged, and each run's token cost is tracked in rupees.

## Prerequisites

- Node.js 22 or newer (`node -v`) — required by better-sqlite3 13. No C++ build tools needed.
- Gemini API key: https://aistudio.google.com/apikey
- Tavily API key: https://tavily.com (free tier is enough)

## Setup

```sh
git clone <repo-url> analyst-auditor && cd analyst-auditor
npm install
cp .env.example .env          # then set GEMINI_API_KEY and TAVILY_API_KEY in .env
npm start                     # sanity check: prints "scaffold ready"
```

## Run

| Command | What it does |
|---|---|
| `npm run ask -- "your question"` | Analyst answers one question; prints answer JSON incl. `questionId` |
| `npm run audit -- <questionId>` | Auditor re-checks that answer's claims; prints the audit report |
| `npm run batch -- questions.json` | Ask + audit each question in a JSON array of strings, one at a time |
| `npm run report -- 15,16,17` | Cost/quality table for the given question ids (omit ids for all) |

## Example

```sh
npm run ask -- "Who is the current chairman of Tata Sons?"
```

```json
{
  "answer": "The current chairman of Tata Sons is Natarajan Chandrasekaran. He took over as Chairman on February 21, 2017 ...",
  "claims": [
    { "text": "Natarajan Chandrasekaran took over as Chairman of Tata Sons on 21 February 2017.",
      "citedUrl": "https://en.wikipedia.org/wiki/Tata_Sons", "corroboration": "possible_second_source" }
  ],
  "entitiesLearned": [ { "name": "Natarajan Chandrasekaran", "type": "person", "facts": [ ... ] } ],
  "unableToFind": [],
  "questionId": 16,
  "cost": { "totalTokens": 8526, "rupees": 0.336 },
  "durationMs": 11810
}
```

Then `npm run audit -- 16` returns `{ "totalClaims": 2, "supported": 2, "unsupported": 0, "contradicted": 0, "details": [ ... ] }`.

## Where output goes

- `data/memory.db` — SQLite: entity memory, questions (answers + analyst cost), per-step traces,
  `auditReports` (auditor cost kept separate). Override the path with `DB_PATH`.
- `logs/session-<date>.log` — JSON-lines audit trail of every LLM call, tool call and trace step.
- `logs/batch-summary-<timestamp>.json` — written by `npm run batch`.
- `report.csv` — written by `npm run report`.

## Configuration

Optional settings in `.env`:

- `GEMINI_MODEL` — primary model, default `gemini-3.8-flash`.
- `GEMINI_FALLBACK_MODEL` — used once if the primary is still overloaded (429/5xx) after 3
  retries, default `gemini-3.5-flash-lite`. Set it to a different model from the primary, or
  fallback is skipped.
- `USD_TO_INR` — exchange rate for rupee costs, default 88. Model prices are in
  `src/utils/costTracker.js`.

Architecture, trade-offs, testing and known limitations: [DECISIONS.md](DECISIONS.md).
