import { createAgent } from '../factory.js';
import { gather } from './gather.js';
import { buildPrompt } from './prompt.js';

// The Contrarian needs a feeds client (crowd-positioning panel) injected. The
// factory calls gather(gunvest, symbol); we bind feeds into a closure so the
// runner stays unchanged and feeds is easy to fake in tests.
export function createContrarianAgent({ bus, gunvest, provider, config, feeds, logger = console }) {
  return createAgent({
    id: config.id,
    weight: config.weight,
    gather: (gv, symbol) => gather(gv, symbol, feeds),
    buildPrompt,
    bus,
    gunvest,
    provider,
    logger,
  });
}
