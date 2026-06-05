import { cycleWildcard, voteSubject } from '../../bus/subjects.js';
import { createVote } from '../../consensus/vote.js';
import { gather } from './gather.js';
import { buildPrompt } from './prompt.js';
import { parseVote } from './parse.js';

// Subscribes to every cycle, votes, and publishes on the round's vote subject.
export function createTechnicalAgent({ bus, gunvest, provider, config, logger = console }) {
  async function handleCycle({ cycleId, symbol, round }) {
    let vote;
    try {
      const data = await gather(gunvest, symbol);
      const { system, prompt } = buildPrompt(symbol, data);
      const text = await provider.generate({ system, prompt });
      const parsed = parseVote(text, { agentId: config.id, weight: config.weight });
      if (parsed.ok) {
        vote = parsed.vote;
      } else {
        logger.warn(`[${config.id}] parse failed: ${parsed.errors.join('; ')}`);
        vote = abstain(config);
      }
    } catch (err) {
      logger.error(`[${config.id}] cycle error: ${err.message}`);
      vote = abstain(config);
    }
    bus.publishJSON(voteSubject(symbol, round), { cycleId, symbol, round, vote });
  }

  return {
    start() {
      bus.subscribeJSON(cycleWildcard(), (msg) => {
        handleCycle(msg);
      });
    },
  };
}

function abstain(config) {
  return createVote({
    agentId: config.id,
    stance: 0,
    conviction: 0,
    weight: config.weight,
    rationale: 'abstain (no usable signal)',
  });
}
