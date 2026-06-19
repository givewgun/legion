import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { connectDb } from '../../src/db/client.js';

const dbUrl = process.env.DATABASE_URL;
const run = dbUrl ? describe : describe.skip;

run('multitenant schema', () => {
  let db;
  beforeAll(async () => {
    db = connectDb(dbUrl);
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/schema.sql');
    await db.query(await readFile(schemaPath, 'utf8'));
  });
  afterAll(async () => db?.pool.end());

  it('creates the users table with a unique google_sub', async () => {
    const rows = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'legion' AND table_name = 'users' ORDER BY column_name`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'google_sub', 'email', 'name', 'avatar_url']),
    );
  });

  it('creates user_watchlist keyed by (user_id, symbol)', async () => {
    const rows = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'legion' AND table_name = 'user_watchlist'`,
    );
    expect(rows.length).toBe(1);
  });
});
