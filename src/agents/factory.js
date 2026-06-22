import { cycleWildcard, voteSubject } from '../bus/subjects.js';
import { createVote } from '../consensus/vote.js';
import { parseVote } from './parse.js';
import { summarizePeers } from './peers.js';
import { agentInference } from '../instrumentation/metrics.js';
import { normalizeGenerate } from '../llm/provider.js';

// How long a cycle's gathered data stays reusable across revision rounds. A full
// cycle spans minutes; entries older than this belong to a cycle that died and
// are pruned so the cache cannot grow without bound.
const GatherCacheTtlMs = 30 * 60 * 1000;

// The shared runner for every voting agent. Adding an agent = id + weight +
// gather + buildPrompt; the loop (subscribe/gather/reason/parse/publish/abstain)
// lives here once.
//
// The round-1 gather is cached per cycle and reused by revision rounds: market
// data doesn't meaningfully move within a minutes-long debate, and re-fetching
// mid-cycle could hand later rounds a *different* snapshot — the rounds should
// argue over new dissent, not shifting facts (and it saves the fetch).
export function createAgent({
  id,
  weight,
  gather,
  buildPrompt,
  bus,
  gunvest,
  provider,
  getProvider = null,
  getMemory = null,
  logger = console,
  clock = () => Date.now(),
}) {
  const gatherCache = new Map(); // cycleId -> { data, at }

  function pruneGatherCache(nowMs) {
    for (const [cid, entry] of gatherCache) {
      if (nowMs - entry.at > GatherCacheTtlMs) gatherCache.delete(cid);
    }
  }

  async function gatherForCycle(cycleId, symbol) {
    const nowMs = clock();
    pruneGatherCache(nowMs);
    const cached = gatherCache.get(cycleId);
    if (cached) return cached.data;
    const data = await gather(gunvest, symbol);
    gatherCache.set(cycleId, { data, at: nowMs });
    return data;
  }

  async function handleCycle({ cycleId, symbol, round, priorVotes = [] }) {
    let vote;
    try {
      let activeProvider = provider;
      if (getProvider) {
        const resolved = await getProvider({ agentId: id });
        if (resolved && resolved.enabled === false) {
          bus.publishJSON(voteSubject(symbol, round), {
            cycleId,
            symbol,
            round,
            vote: abstain(id, weight, 'disabled'),
          });
          return;
        }
        activeProvider = resolved?.provider ?? provider;
      }
      const data = await gatherForCycle(cycleId, symbol);
      const peers = summarizePeers(priorVotes, id);
      // Outcome-grounded memory (ADR 0025): the agent's own graded track record,
      // prepended as context. Best-effort — a memory failure must not block a vote.
      let memory = '';
      if (getMemory) {
        try {
          memory = (await getMemory({ symbol })) ?? '';
        } catch (err) {
          logger.warn(`[${id}] memory fetch failed: ${err.message}`);
        }
      }
      const { system, prompt } = buildPrompt(symbol, data, peers);
      // Time the reasoning step (LLM generate) per agent for the dashboards.
      const stopInference = agentInference.startTimer({ agent: id });
      let text;
      let servedModel = null;
      let servedSource = null;
      try {
        const out = await normalizeGenerate(activeProvider, {
          system,
          prompt: memory ? `${memory}\n\n${prompt}` : prompt,
        });
        text = out.text;
        servedModel = out.model;
        servedSource = out.source;
      } finally {
        stopInference();
      }
      const parsed = parseVote(text, { agentId: id, weight, model: servedModel, source: servedSource });
      if (parsed.ok) {
        vote = parsed.vote;
      } else {
        logger.warn(`[${id}] parse failed: ${parsed.errors.join('; ')}`);
        vote = abstain(id, weight, 'unparseable vote', servedModel, servedSource);
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

function abstain(id, weight, reason, model = null, source = null) {
  return createVote({
    agentId: id,
    stance: 0,
    conviction: 0,
    weight,
    rationale: `abstain (${reason})`,
    model,
    source,
  });
}
