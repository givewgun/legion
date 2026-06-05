import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { createTechnicalAgent } from '../agents/technical/index.js';
import { technicalConfig } from '../agents/technical/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestClient(cfg.gunvestApiUrl);
const provider = createProvider(technicalConfig.provider, cfg);

createTechnicalAgent({ bus, gunvest, provider, config: technicalConfig }).start();
console.log('[technical] listening for cycles');
