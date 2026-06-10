import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { connectBus } from '../bus/nats.js';
import { createOrchestrator } from '../orchestrator.js';
import { createApp } from '../api/app.js';
import { createGunvestFromConfig } from '../data/gunvest.js';

const cfg = loadConfig();
const repo = createRepo(connectDb(cfg.databaseUrl));

// Connect the bus so the on-demand trigger endpoint can kick cycles. If NATS is
// unreachable the API still serves read routes; trigger endpoints return 503.
let orchestrator = null;
try {
  const bus = await connectBus(cfg.natsUrl);
  orchestrator = createOrchestrator({ bus, repo });
  console.log('[api] bus connected — POST /api/trigger enabled');
} catch (err) {
  console.warn(`[api] bus unavailable — trigger endpoint disabled: ${err.message}`);
}

const gunvest = createGunvestFromConfig(cfg);
const app = createApp({ repo, orchestrator, gunvest, horizonDays: cfg.horizonDays });
app.listen(cfg.apiPort, () => console.log(`[api] listening on :${cfg.apiPort}`));
