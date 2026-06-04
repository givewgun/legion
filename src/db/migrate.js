import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectDb } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigration(db, sqlPath) {
  const sql = await readFile(sqlPath, 'utf8');
  await db.query(sql);
}

// Entry point: `npm run db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const db = connectDb(cfg.databaseUrl);
  const sqlPath = join(__dirname, 'schema.sql');
  runMigration(db, sqlPath)
    .then(() => {
      console.log('legion schema migrated');
      return db.pool.end();
    })
    .catch((err) => {
      console.error('migration failed:', err.message);
      process.exit(1);
    });
}
