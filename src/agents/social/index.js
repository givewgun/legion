import { createAgent } from '../factory.js';
import { gather } from './gather.js';
import { buildPrompt } from './prompt.js';

export function createSocialAgent({ bus, gunvest, provider, config, logger = console }) {
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
