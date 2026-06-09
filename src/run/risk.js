import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestFromConfig } from '../data/gunvest.js';
import { createRiskManager } from '../risk/manager.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestFromConfig(cfg);

createRiskManager({ bus, gunvest }).start();
console.log('[risk] listening for cycles');
