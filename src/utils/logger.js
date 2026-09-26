// Append-only JSON-lines audit trail: logs/session-<YYYY-MM-DD>.log
// The LLM and tool wrappers call this themselves — callers never need to.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'logs');
mkdirSync(LOG_DIR, { recursive: true });

export const SESSION_ID = randomUUID();

function logPath() {
  return join(LOG_DIR, `session-${new Date().toISOString().slice(0, 10)}.log`);
}

// Sync append so entries are never lost if the process crashes mid-run.
export function log(event, data = {}) {
  const entry = { ts: new Date().toISOString(), session: SESSION_ID, event, ...data };
  appendFileSync(logPath(), JSON.stringify(entry) + '\n');
  return entry;
}

// Wraps an async function so every call logs start, result/error and duration.
// `logArgs` / `summarize` let the caller trim args and results before they hit the log.
export function withLogging(kind, name, fn, { logArgs = (a) => a, summarize = (r) => r } = {}) {
  return async (...args) => {
    const callId = randomUUID();
    const started = Date.now();
    log(`${kind}.start`, { callId, name, args: logArgs(args) });
    try {
      const result = await fn(...args);
      log(`${kind}.end`, { callId, name, duration_ms: Date.now() - started, result: summarize(result) });
      return result;
    } catch (err) {
      log(`${kind}.error`, { callId, name, duration_ms: Date.now() - started, error: err.message });
      throw err;
    }
  };
}
