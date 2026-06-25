import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestFromConfig } from '../data/gunvest.js';
import { createProvider, withAgentOptions } from '../llm/provider.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { buildGetProvider } from '../agents/get-provider.js';
import { buildGetMemory } from '../agents/memory.js';
import { createContrarianFeeds } from '../data/feeds/index.js';
import { createContrarianAgent } from '../agents/contrarian/index.js';
import { contrarianConfig } from '../agents/contrarian/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestFromConfig(cfg);
const provider = createProvider(
  contrarianConfig.provider,
  withAgentOptions(cfg, contrarianConfig.options),
);

// Real crowd-positioning panel: F&G + VIX reused from GunVest; put/call, AAII,
// NAAIM, and short interest fetched legion-side (each degrades to null on failure).
const feeds = createContrarianFeeds({ gunvest, finnhubApiKey: cfg.finnhubApiKey });
// Honor runtime per-agent config (provider/model/enabled) from legion.agent_config,
// resolved per cycle so dashboard changes apply on the next evaluation.
const repo = createRepo(connectDb(cfg.databaseUrl));
const getProvider = buildGetProvider({
  repo,
  cfg,
  options: contrarianConfig.options,
  defaultProvider: contrarianConfig.provider,
});
// Outcome-grounded memory (ADR 0025): the agent sees its own graded record.
const getMemory = buildGetMemory({ repo, agentId: contrarianConfig.id });

createContrarianAgent({
  bus,
  gunvest,
  provider,
  getProvider,
  getMemory,
  config: contrarianConfig,
  feeds,
}).start();
console.log('[contrarian] listening for cycles');
