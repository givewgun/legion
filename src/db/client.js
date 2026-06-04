import pg from 'pg';

// Wraps a pg Pool. Accepts an injected pool for tests.
export function createDb(pool) {
  return {
    async query(text, params = []) {
      const result = await pool.query(text, params);
      return result.rows;
    },
    async queryOne(text, params = []) {
      const rows = await this.query(text, params);
      return rows.length > 0 ? rows[0] : null;
    },
    pool,
  };
}

// Builds a real pool from a connection string.
export function connectDb(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  return createDb(pool);
}
