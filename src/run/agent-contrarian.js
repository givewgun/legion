import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { createContrarianFeeds } from '../data/feeds/index.js';
import { createContrarianAgent } from '../agents/contrarian/index.js';
import { contrarianConfig } from '../agents/contrarian/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestClient(cfg.gunvestApiUrl);
const provider = createProvider(contrarianConfig.provider, cfg);

// Real crowd-positioning panel: F&G + VIX reused from GunVest; put/call, AAII,
// NAAIM, and short interest fetched legion-side (each degrades to null on failure).
const feeds = createContrarianFeeds({ gunvest, finnhubApiKey: cfg.finnhubApiKey });

createContrarianAgent({ bus, gunvest, provider, config: contrarianConfig, feeds }).start();
console.log('[contrarian] listening for cycles');
