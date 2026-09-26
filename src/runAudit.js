// Usage: node src/runAudit.js <question_id>
import 'dotenv/config';
import { createStore } from './memory/db.js';
import { runAuditor } from './agents/auditor.js';

const id = Number(process.argv[2]);
if (!Number.isInteger(id)) {
  console.error('Usage: node src/runAudit.js <question_id>');
  process.exit(1);
}

const store = createStore();
try {
  const report = await runAuditor(id, { store });
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  console.error(`Audit failed: ${err.message} (see logs/ for the trace)`);
  process.exitCode = 1;
} finally {
  store.close();
}
