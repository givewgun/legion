import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createRiskManager } from '../risk/manager.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestClient(cfg.gunvestApiUrl);

createRiskManager({ bus, gunvest }).start();
console.log('[risk] listening for cycles');
