// Usage: node src/generateReport.js [id,id,...]   (no ids = every question)
// Prints a markdown cost/quality table and writes the same rows to report.csv in the project root.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './memory/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSV_PATH = join(ROOT, 'report.csv');

const arg = process.argv[2];
const ids = arg ? arg.split(',').map((s) => Number(s.trim())) : null;
if (ids?.some((n) => !Number.isInteger(n))) {
  console.error('Usage: node src/generateReport.js 15,16,17   (comma-separated question ids)');
  process.exit(1);
}

// Latest audit per question (re-audits would otherwise duplicate rows in the join).
// Rows come back in id order, which is run order — the cost trend below relies on it.
const SQL = `
SELECT
  q.id, q.question_text, q.answer IS NOT NULL AS answered,
  q.cost_tokens AS analyst_tokens, q.cost_rupees AS analyst_rupees, q.duration_ms AS analyst_ms,
  a.id AS audit_id, a.cost_tokens AS audit_tokens, a.cost_rupees AS audit_rupees, a.duration_ms AS audit_ms,
  a.supported, a.unsupported, a.contradicted,
  EXISTS (SELECT 1 FROM traces t WHERE t.question_id = q.id AND t.step_type = 'memory_hit') AS memory_hit
FROM questions q
LEFT JOIN auditReports a
  ON a.id = (SELECT MAX(id) FROM auditReports WHERE question_id = q.id)
${ids ? `WHERE q.id IN (${ids.map(() => '?').join(',')})` : ''}
ORDER BY q.id`;

const store = createStore();
const rows = store.db.prepare(SQL).all(...(ids ?? [])).map((r) => ({
  ...r,
  audit_tokens: r.audit_tokens ?? 0,
  audit_rupees: r.audit_rupees ?? 0,
  total_rupees: r.analyst_rupees + (r.audit_rupees ?? 0),
  duration_ms: (r.analyst_ms ?? 0) + (r.audit_ms ?? 0),
}));
store.close();

const missing = ids?.filter((id) => !rows.some((r) => r.id === id)) ?? [];
if (missing.length) console.error(`Warning: no question with id ${missing.join(', ')}`);
if (!rows.length) {
  console.error('No matching questions.');
  process.exit(1);
}

// ---------- markdown ----------

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const md = (s) => String(s).replace(/\|/g, '\\|');
const rs = (n) => `₹${n.toFixed(3)}`;
const claims = (r) =>
  r.audit_id == null ? (r.answered ? 'not audited' : 'failed') : `${r.supported}/${r.unsupported}/${r.contradicted}`;

const header = ['Q#', 'Question', 'Analyst tokens', 'Analyst ₹', 'Audit tokens', 'Audit ₹', 'Total ₹', 'Duration (s)', 'Claims (S/U/C)', 'Memory hit?'];
const lines = [
  `| ${header.join(' | ')} |`,
  `| ${header.map((_, i) => (i >= 2 && i <= 7 ? '---:' : '---')).join(' | ')} |`,
  ...rows.map(
    (r) =>
      `| ${[
        r.id,
        md(truncate(r.question_text, 60)),
        r.analyst_tokens,
        rs(r.analyst_rupees),
        r.audit_tokens,
        rs(r.audit_rupees),
        rs(r.total_rupees),
        (r.duration_ms / 1000).toFixed(1),
        claims(r),
        r.memory_hit ? 'yes' : 'no',
      ].join(' | ')} |`,
  ),
];
console.log(lines.join('\n'));

// ---------- csv (full question text, raw numbers, one column per verdict for charting) ----------

const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csvCols = [
  ['question_id', (r) => r.id],
  ['question', (r) => r.question_text],
  ['status', (r) => (!r.answered ? 'analyst_failed' : r.audit_id == null ? 'not_audited' : 'ok')],
  ['analyst_tokens', (r) => r.analyst_tokens],
  ['analyst_rupees', (r) => r.analyst_rupees.toFixed(4)],
  ['audit_tokens', (r) => r.audit_tokens],
  ['audit_rupees', (r) => r.audit_rupees.toFixed(4)],
  ['total_rupees', (r) => r.total_rupees.toFixed(4)],
  ['duration_ms', (r) => r.duration_ms],
  ['supported', (r) => r.supported],
  ['unsupported', (r) => r.unsupported],
  ['contradicted', (r) => r.contradicted],
  ['memory_hit', (r) => (r.memory_hit ? 'yes' : 'no')],
];
const csv = [csvCols.map(([h]) => h), ...rows.map((r) => csvCols.map(([, f]) => f(r)))]
  .map((row) => row.map(csvCell).join(','))
  .join('\r\n');
writeFileSync(CSV_PATH, `﻿${csv}\r\n`); // BOM so Excel reads it as UTF-8

// ---------- summary ----------

const avg = (list, key) => list.reduce((t, r) => t + r[key], 0) / list.length;
const total = rows.reduce((t, r) => t + r.total_rupees, 0);
// Odd count: the middle question sits in neither half, so both halves are the same size.
const half = Math.floor(rows.length / 2);
const change = (key) => {
  const first = avg(rows.slice(0, half), key);
  const second = avg(rows.slice(-half), key);
  const pct = ((second - first) / first) * 100;
  return `${rs(first)} → ${rs(second)} (${pct <= 0 ? '' : '+'}${pct.toFixed(0)}%, ${pct < 0 ? 'fell' : 'did not fall'})`;
};
// Audit cost scales with claim count, not memory, so the analyst-only trend is the memory signal.
const trend =
  half > 0
    ? `trend first ${half} vs last ${half} avg: total ${change('total_rupees')}; analyst only ${change('analyst_rupees')}`
    : 'trend: need at least 2 questions';
console.log(
  `\nTotal ${rs(total)} across ${rows.length} questions · avg ${rs(total / rows.length)}/question · ${trend}`,
);
console.error(`CSV written to ${CSV_PATH}`);
