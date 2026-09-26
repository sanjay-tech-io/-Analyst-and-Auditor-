// Usage: node src/runBatch.js [questions.json]
// Runs each question through analyst → auditor, one question at a time, and writes a summary
// to logs/batch-summary-<timestamp>.json. Searches within a question stay parallel.
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './memory/db.js';
import { runAnalyst } from './agents/analyst.js';
import { runAuditor } from './agents/auditor.js';
import { log } from './utils/logger.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAUSE_MS = 5_000; // between questions, to stay under per-minute rate limits

const file = resolve(process.argv[2] ?? join(ROOT, 'questions.json'));
let questions;
try {
  questions = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Could not read ${file}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(questions) || !questions.every((q) => typeof q === 'string' && q.trim())) {
  console.error(`${file} must be a JSON array of non-empty question strings`);
  process.exit(1);
}

const started = new Date();
const summaryPath = join(ROOT, 'logs', `batch-summary-${started.toISOString().replace(/[:.]/g, '-')}.json`);
const store = createStore();
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rs = (n) => `₹${n.toFixed(2)}`;

// Rewritten after every question so an interrupted batch still leaves a usable summary.
function writeSummary(finished = false) {
  const sum = (k) => rows.reduce((t, r) => t + r[k], 0);
  const summary = {
    file,
    startedAt: started.toISOString(),
    finishedAt: finished ? new Date().toISOString() : null,
    totalQuestions: questions.length,
    completed: rows.length,
    failed: rows.filter((r) => r.status !== 'ok').length,
    totals: {
      analystTokens: sum('analystTokens'),
      analystRupees: sum('analystRupees'),
      auditorTokens: sum('auditorTokens'),
      auditorRupees: sum('auditorRupees'),
      durationMs: sum('durationMs'),
    },
    questions: rows,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  return summary;
}

// A failed analyst run has still written its partial spend to the questions table.
function failedRunCost(minId, question) {
  const row = store.db
    .prepare('SELECT id, cost_tokens, cost_rupees FROM questions WHERE id > ? AND question_text = ? ORDER BY id DESC LIMIT 1')
    .get(minId, question);
  return { questionId: row?.id ?? null, tokens: row?.cost_tokens ?? 0, rupees: row?.cost_rupees ?? 0 };
}

log('batch.start', { file, questions: questions.length });

for (const [i, question] of questions.entries()) {
  if (i > 0) await sleep(PAUSE_MS);
  const label = question.length > 80 ? `${question.slice(0, 77)}...` : question;
  process.stdout.write(`[${i + 1}/${questions.length}] Running: ${label}... `);

  const t0 = Date.now();
  const maxIdBefore = store.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM questions').get().id;
  const row = {
    n: i + 1,
    question,
    questionId: null,
    status: 'ok',
    analystTokens: 0,
    analystRupees: 0,
    auditorTokens: 0,
    auditorRupees: 0,
    durationMs: 0,
    answerPreview: '',
    audit: null,
    error: null,
  };

  try {
    const result = await runAnalyst(question, { store });
    Object.assign(row, {
      questionId: result.questionId,
      analystTokens: result.cost.totalTokens,
      analystRupees: result.cost.rupees,
      answerPreview: result.answer.replace(/\s+/g, ' ').slice(0, 120),
    });

    try {
      const audit = await runAuditor(result.questionId, { store });
      Object.assign(row, {
        auditorTokens: audit.cost.totalTokens,
        auditorRupees: audit.cost.rupees,
        audit: {
          auditId: audit.auditId,
          totalClaims: audit.totalClaims,
          supported: audit.supported,
          unsupported: audit.unsupported,
          contradicted: audit.contradicted,
        },
      });
    } catch (err) {
      row.status = 'audit_failed';
      row.error = err.message;
    }
  } catch (err) {
    const partial = failedRunCost(maxIdBefore, question);
    Object.assign(row, {
      status: 'analyst_failed',
      error: err.message,
      questionId: partial.questionId,
      analystTokens: partial.tokens,
      analystRupees: partial.rupees,
    });
  }

  row.durationMs = Date.now() - t0;
  rows.push(row);
  writeSummary();
  log('batch.question', { n: row.n, questionId: row.questionId, status: row.status, durationMs: row.durationMs, error: row.error });

  const cost = rs(row.analystRupees + row.auditorRupees);
  const auditNote = row.audit ? `, audit ${row.audit.supported}/${row.audit.totalClaims} supported` : '';
  console.log(
    row.status === 'ok'
      ? `done (${cost}, ${row.durationMs}ms${auditNote})`
      : `FAILED: ${row.status} — ${row.error} (${cost} spent, ${row.durationMs}ms)`,
  );
}

store.close();
const summary = writeSummary(true);
log('batch.end', { summaryPath, ...summary.totals, failed: summary.failed });

console.log('\nSummary');
console.table(
  rows.map((r) => ({
    '#': r.n,
    status: r.status,
    'analyst tok': r.analystTokens,
    'analyst ₹': +r.analystRupees.toFixed(3),
    'auditor tok': r.auditorTokens,
    'auditor ₹': +r.auditorRupees.toFixed(3),
    'ms': r.durationMs,
    answer: r.status === 'analyst_failed' ? `(failed) ${r.error.slice(0, 50)}` : r.answerPreview.slice(0, 60),
  })),
);
const t = summary.totals;
console.log(
  `Total: analyst ${t.analystTokens} tok / ${rs(t.analystRupees)}, auditor ${t.auditorTokens} tok / ${rs(t.auditorRupees)}, ` +
    `${(t.durationMs / 1000).toFixed(1)}s, ${summary.failed} failed`,
);
console.log(`Summary written to ${summaryPath}`);
