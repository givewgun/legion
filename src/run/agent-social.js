import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestFromConfig } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { buildGetProvider } from '../agents/get-provider.js';
import { createSocialAgent } from '../agents/social/index.js';
import { socialConfig } from '../agents/social/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestFromConfig(cfg);
const provider = createProvider(socialConfig.provider, cfg);
// Honor runtime per-agent config (provider/model/enabled) from legion.agent_config,
// resolved per cycle so dashboard changes apply on the next evaluation.
const getProvider = buildGetProvider({ repo: createRepo(connectDb(cfg.databaseUrl)), cfg });

createSocialAgent({ bus, gunvest, provider, getProvider, config: socialConfig }).start();
console.log('[social] listening for cycles');
