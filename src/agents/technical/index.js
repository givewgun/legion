import { createAgent } from '../factory.js';
import { gather } from './gather.js';
import { buildPrompt } from './prompt.js';

// Thin wrapper preserving the Phase 1 signature; all behavior is in createAgent.
export function createTechnicalAgent({ bus, gunvest, provider, config, logger = console }) {
  return createAgent({
    id: config.id,
    weight: config.weight,
    gather,
    buildPrompt,
    bus,
    gunvest,
    provider,
    logger,
  });
}
