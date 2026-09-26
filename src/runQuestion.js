// Usage: node src/runQuestion.js "your question here"
import 'dotenv/config';
import { createStore } from './memory/db.js';
import { runAnalyst } from './agents/analyst.js';

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('Usage: node src/runQuestion.js "your question here"');
  process.exit(1);
}

const store = createStore();
try {
  const result = await runAnalyst(question, { store });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`Analyst failed: ${err.message} (see logs/ for the trace)`);
  process.exitCode = 1;
} finally {
  store.close();
}
