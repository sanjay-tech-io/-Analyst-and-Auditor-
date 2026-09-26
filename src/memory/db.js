// SQLite store: cross-question entity memory, per-question results, and step traces.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'memory.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  data         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name, type)
);

CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  question_text TEXT NOT NULL,
  answer        TEXT,
  cost_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_rupees   REAL    NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  timestamp     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS traces (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  step_type   TEXT NOT NULL CHECK (step_type IN ('plan', 'tool_call', 'tool_result', 'decision', 'memory_hit')),
  content     TEXT NOT NULL CHECK (json_valid(content)),
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (question_id, step_number)
);

-- One row per audit run. Cost is the auditor's own, kept apart from the analyst's in questions.
CREATE TABLE IF NOT EXISTS auditReports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id  INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  total_claims INTEGER NOT NULL,
  supported    INTEGER NOT NULL,
  unsupported  INTEGER NOT NULL,
  contradicted INTEGER NOT NULL,
  cost_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_rupees  REAL    NOT NULL DEFAULT 0,
  duration_ms  INTEGER,
  report       TEXT CHECK (report IS NULL OR json_valid(report)),
  timestamp    TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(path = process.env.DB_PATH || DEFAULT_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function createStore(db = openDb()) {
  const stmts = {
    upsertEntity: db.prepare(`
      INSERT INTO entities (name, type, data, last_updated) VALUES (?, ?, json(?), datetime('now'))
      ON CONFLICT(name, type) DO UPDATE SET data = excluded.data, last_updated = excluded.last_updated`),
    getEntity: db.prepare('SELECT * FROM entities WHERE name = ? AND type = ?'),
    getEntityByName: db.prepare(
      'SELECT * FROM entities WHERE name = ? COLLATE NOCASE ORDER BY last_updated DESC LIMIT 1'),
    findEntities: db.prepare('SELECT * FROM entities WHERE name LIKE ? ORDER BY last_updated DESC'),
    insertQuestion: db.prepare('INSERT INTO questions (question_text) VALUES (?)'),
    finishQuestion: db.prepare(`
      UPDATE questions SET answer = ?, cost_tokens = ?, cost_rupees = ?, duration_ms = ? WHERE id = ?`),
    insertTrace: db.prepare(`
      INSERT INTO traces (question_id, step_number, step_type, content)
      VALUES (?, (SELECT COALESCE(MAX(step_number), 0) + 1 FROM traces WHERE question_id = ?), ?, json(?))`),
    getTraces: db.prepare('SELECT * FROM traces WHERE question_id = ? ORDER BY step_number'),
    getQuestion: db.prepare('SELECT * FROM questions WHERE id = ?'),
    insertAuditReport: db.prepare(`
      INSERT INTO auditReports
        (question_id, total_claims, supported, unsupported, contradicted, cost_tokens, cost_rupees, duration_ms, report)
      VALUES (@questionId, @totalClaims, @supported, @unsupported, @contradicted, @costTokens, @costRupees, @durationMs, json(@report))`),
  };

  const parse = (row, field) => row && { ...row, [field]: JSON.parse(row[field]) };

  return {
    db,
    upsertEntity: (name, type, data) => stmts.upsertEntity.run(name, type, JSON.stringify(data)),
    getEntity: (name, type) => parse(stmts.getEntity.get(name, type), 'data'),
    getEntityByName: (name) => parse(stmts.getEntityByName.get(name), 'data'),
    findEntities: (pattern) => stmts.findEntities.all(`%${pattern}%`).map((r) => parse(r, 'data')),
    startQuestion: (text) => Number(stmts.insertQuestion.run(text).lastInsertRowid),
    finishQuestion: (id, { answer, costTokens, costRupees, durationMs }) =>
      stmts.finishQuestion.run(answer, costTokens, costRupees, durationMs, id),
    addTrace: (questionId, stepType, content) =>
      stmts.insertTrace.run(questionId, questionId, stepType, JSON.stringify(content)),
    getTraces: (questionId) => stmts.getTraces.all(questionId).map((r) => parse(r, 'content')),
    getQuestion: (id) => {
      const row = stmts.getQuestion.get(id);
      return row && { ...row, answer: row.answer && JSON.parse(row.answer) };
    },
    insertAuditReport: (r) =>
      Number(stmts.insertAuditReport.run({ ...r, report: JSON.stringify(r.report) }).lastInsertRowid),
    close: () => db.close(),
  };
}
