import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { createNewsAgent } from '../agents/news/index.js';
import { newsConfig } from '../agents/news/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestClient(cfg.gunvestApiUrl);
const provider = createProvider(newsConfig.provider, cfg);

createNewsAgent({ bus, gunvest, provider, config: newsConfig }).start();
console.log('[news] listening for cycles');
