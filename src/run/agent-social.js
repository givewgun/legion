import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { createSocialAgent } from '../agents/social/index.js';
import { socialConfig } from '../agents/social/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestClient(cfg.gunvestApiUrl);
const provider = createProvider(socialConfig.provider, cfg);

createSocialAgent({ bus, gunvest, provider, config: socialConfig }).start();
console.log('[social] listening for cycles');
