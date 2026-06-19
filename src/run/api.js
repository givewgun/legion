import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { connectBus } from '../bus/nats.js';
import { createOrchestrator } from '../orchestrator.js';
import { createApp } from '../api/app.js';
import { createGunvestFromConfig } from '../data/gunvest.js';
import { createGoogleAuth } from '../auth/google.js';
import { createSessionMiddleware } from '../auth/session.js';

const cfg = loadConfig();
const db = connectDb(cfg.databaseUrl);
const repo = createRepo(db);

let orchestrator = null;
try {
  const bus = await connectBus(cfg.natsUrl);
  orchestrator = createOrchestrator({ bus, repo });
  console.log('[api] bus connected — POST /api/trigger enabled');
} catch (err) {
  console.warn(`[api] bus unavailable — trigger endpoint disabled: ${err.message}`);
}

const gunvest = createGunvestFromConfig(cfg);

// Build the auth stack. Secure cookies in production (HTTPS terminates at the
// Cloudflare edge); plain HTTP only for local dev.
const isProd = process.env.NODE_ENV === 'production';
const auth = {
  session: createSessionMiddleware({
    pool: db.pool,
    secret: cfg.auth.sessionSecret,
    secure: isProd,
  }),
  google: createGoogleAuth({
    clientId: cfg.auth.googleClientId,
    clientSecret: cfg.auth.googleClientSecret,
    redirectUri: `${cfg.auth.publicUrl}/api/auth/google/callback`,
  }),
  allowedEmails: cfg.auth.allowedEmails,
  repo,
};

const app = createApp({ repo, orchestrator, gunvest, horizonDays: cfg.horizonDays, auth });
app.listen(cfg.apiPort, () => console.log(`[api] listening on :${cfg.apiPort}`));
