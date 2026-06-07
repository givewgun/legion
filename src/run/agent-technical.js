import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { buildGetProvider } from '../agents/get-provider.js';
import { createTechnicalAgent } from '../agents/technical/index.js';
import { technicalConfig } from '../agents/technical/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestClient(cfg.gunvestApiUrl);
const provider = createProvider(technicalConfig.provider, cfg);
// Honor runtime per-agent config (provider/model/enabled) from legion.agent_config,
// resolved per cycle so dashboard changes apply on the next evaluation.
const getProvider = buildGetProvider({ repo: createRepo(connectDb(cfg.databaseUrl)), cfg });

createTechnicalAgent({ bus, gunvest, provider, getProvider, config: technicalConfig }).start();
console.log('[technical] listening for cycles');
