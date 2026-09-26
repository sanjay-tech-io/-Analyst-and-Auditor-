import 'dotenv/config';
import { createStore } from './memory/db.js';
import { log } from './utils/logger.js';

const store = createStore();
const tables = store.db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  .pluck()
  .all();

log('scaffold.ready', { tables });
console.log('scaffold ready', { tables });
store.close();
