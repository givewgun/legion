import { createAgent } from '../factory.js';
import { gather } from './gather.js';
import { buildPrompt } from './prompt.js';

export function createNewsAgent({
  bus,
  gunvest,
  provider,
  config,
  getProvider = null,
  logger = console,
}) {
  return createAgent({
    id: config.id,
    weight: config.weight,
    gather,
    buildPrompt,
    bus,
    gunvest,
    provider,
    getProvider,
    logger,
  });
}
