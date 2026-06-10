import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestFromConfig } from '../data/gunvest.js';
import { createProvider, withAgentOptions } from '../llm/provider.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { buildGetProvider } from '../agents/get-provider.js';
import { buildGetMemory } from '../agents/memory.js';
import { createTechnicalAgent } from '../agents/technical/index.js';
import { technicalConfig } from '../agents/technical/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestFromConfig(cfg);
const provider = createProvider(
  technicalConfig.provider,
  withAgentOptions(cfg, technicalConfig.options),
);
// Honor runtime per-agent config (provider/model/enabled) from legion.agent_config,
// resolved per cycle so dashboard changes apply on the next evaluation.
const repo = createRepo(connectDb(cfg.databaseUrl));
const getProvider = buildGetProvider({ repo, cfg, options: technicalConfig.options });
// Outcome-grounded memory (ADR 0025): the agent sees its own graded record.
const getMemory = buildGetMemory({ repo, agentId: technicalConfig.id });

createTechnicalAgent({
  bus,
  gunvest,
  provider,
  getProvider,
  getMemory,
  config: technicalConfig,
}).start();
console.log('[technical] listening for cycles');
