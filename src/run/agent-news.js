import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestFromConfig } from '../data/gunvest.js';
import { createProvider, withAgentOptions } from '../llm/provider.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { buildGetProvider } from '../agents/get-provider.js';
import { createNewsAgent } from '../agents/news/index.js';
import { newsConfig } from '../agents/news/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestFromConfig(cfg);
const provider = createProvider(newsConfig.provider, withAgentOptions(cfg, newsConfig.options));
// Honor runtime per-agent config (provider/model/enabled) from legion.agent_config,
// resolved per cycle so dashboard changes apply on the next evaluation.
const getProvider = buildGetProvider({
  repo: createRepo(connectDb(cfg.databaseUrl)),
  cfg,
  options: newsConfig.options,
});

createNewsAgent({ bus, gunvest, provider, getProvider, config: newsConfig }).start();
console.log('[news] listening for cycles');
