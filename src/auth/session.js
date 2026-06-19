import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

// Postgres-backed session store over legion.user_session (created by schema.sql,
// so createTableIfMissing is false). `secure` cookies in prod (HTTPS at the
// Cloudflare edge); SameSite=Lax allows the OAuth redirect to carry the cookie.
export function createSessionMiddleware({ pool, secret, secure }) {
  const PgStore = connectPgSimple(session);
  return session({
    store: new PgStore({
      pool,
      schemaName: 'legion',
      tableName: 'user_session',
      createTableIfMissing: false,
    }),
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  });
}
