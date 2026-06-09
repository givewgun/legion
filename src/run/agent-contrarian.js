import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestFromConfig } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { buildGetProvider } from '../agents/get-provider.js';
import { createContrarianFeeds } from '../data/feeds/index.js';
import { createContrarianAgent } from '../agents/contrarian/index.js';
import { contrarianConfig } from '../agents/contrarian/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestFromConfig(cfg);
const provider = createProvider(contrarianConfig.provider, cfg);

// Real crowd-positioning panel: F&G + VIX reused from GunVest; put/call, AAII,
// NAAIM, and short interest fetched legion-side (each degrades to null on failure).
const feeds = createContrarianFeeds({ gunvest, finnhubApiKey: cfg.finnhubApiKey });
// Honor runtime per-agent config (provider/model/enabled) from legion.agent_config,
// resolved per cycle so dashboard changes apply on the next evaluation.
const getProvider = buildGetProvider({ repo: createRepo(connectDb(cfg.databaseUrl)), cfg });

createContrarianAgent({ bus, gunvest, provider, getProvider, config: contrarianConfig, feeds }).start();
console.log('[contrarian] listening for cycles');
