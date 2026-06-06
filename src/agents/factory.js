import { cycleWildcard, voteSubject } from '../bus/subjects.js';
import { createVote } from '../consensus/vote.js';
import { parseVote } from './parse.js';
import { summarizePeers } from './peers.js';

// The shared runner for every voting agent. Adding an agent = id + weight +
// gather + buildPrompt; the loop (subscribe/gather/reason/parse/publish/abstain)
// lives here once.
export function createAgent({
  id,
  weight,
  gather,
  buildPrompt,
  bus,
  gunvest,
  provider,
  logger = console,
}) {
  async function handleCycle({ cycleId, symbol, round, priorVotes = [] }) {
    let vote;
    try {
      const data = await gather(gunvest, symbol);
      const peers = summarizePeers(priorVotes, id);
      const { system, prompt } = buildPrompt(symbol, data, peers);
      const text = await provider.generate({ system, prompt });
      const parsed = parseVote(text, { agentId: id, weight });
      if (parsed.ok) {
        vote = parsed.vote;
      } else {
        logger.warn(`[${id}] parse failed: ${parsed.errors.join('; ')}`);
        vote = abstain(id, weight, 'unparseable vote');
      }
    } catch (err) {
      logger.error(`[${id}] cycle error: ${err.message}`);
      vote = abstain(id, weight, `data fetch failed: ${err.message}`);
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

function abstain(id, weight, reason) {
  return createVote({
    agentId: id,
    stance: 0,
    conviction: 0,
    weight,
    rationale: `abstain (${reason})`,
  });
}
