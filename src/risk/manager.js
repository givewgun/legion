import { cycleWildcard, constraintSubject } from '../bus/subjects.js';
import { gatherRisk } from './gather.js';
import { computeConstraint } from './rules.js';

// Non-voting constraint node. Subscribes cycles like an agent, but publishes a
// constraint (not a vote). The emitter awaits this before finalizing.
export function createRiskManager({ bus, gunvest, logger = console }) {
  async function handleCycle({ cycleId, symbol, round }) {
    let constraint;
    try {
      const data = await gatherRisk(gunvest, symbol);
      constraint = computeConstraint(data);
    } catch (err) {
      logger.error(`[risk] cycle error: ${err.message}`);
      constraint = { capConviction: 1, blockBuy: false, reason: 'risk data unavailable' };
    }
    bus.publishJSON(constraintSubject(symbol, round), { cycleId, symbol, round, constraint });
  }

  return {
    start() {
      bus.subscribeJSON(cycleWildcard(), (msg) => {
        handleCycle(msg);
      });
    },
  };
}
