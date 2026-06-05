# Legion Phase 2 — Multi-Agent Consensus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-agent pipeline into the real gestalt: four voting agents (Technical, News/Catalyst, Social, Contrarian) plus a non-voting Risk Manager constraint node reach leaderless consensus over one or more rounds, with dissent feedback between rounds, across multiple tickers on a schedule.

**Architecture:** Every voting agent shares one runner (`src/agents/factory.js`) so adding an agent is just config + gather + prompt. Agents still subscribe `legion.cycle.*` and publish votes on `legion.vote.*`; multi-round iteration reuses the **same** cycle subject — the emitter republishes `legion.cycle.<T>` with an incremented `round` and the prior round's votes as `priorVotes`, and agents fold the strongest opposing rationales into their next prompt. The Risk Manager subscribes cycles, computes a deterministic constraint, and publishes it on `legion.constraint.<T>.<r>`; the emitter waits for all votes **and** the constraint before finalizing, applies the constraint to the signal (never to direction), persists **every** round for the debate viewer, and emits only on the final round. A cron scheduler kicks every enabled ticker.

**Tech Stack:** Same as Phase 0/1 (Node ESM, Vitest, `pg`, `nats`, native `fetch`). Adds `node-cron` for scheduling (already used by GunVest — same dependency family).

**Prerequisites:** Phase 0 (`2026-06-04-legion-phase0-foundation.md`) and Phase 1 (`2026-06-04-legion-phase1-single-agent.md`) complete and green.

Spec: `legion/docs/superpowers/specs/2026-06-04-legion-design.md` (§3 consensus iteration/termination, §3.8 Risk Manager constraint, §4 roster, §4.1 contrarian feeds, §5 architecture).

---

## Phase 0/1 interfaces this plan depends on (do not redefine)

- `src/bus/subjects.js` → `cycleSubject(t)`, `voteSubject(t, r)`, `consensusSubject(t)`, `cycleWildcard()`, `voteWildcard()`, plus module-level `PREFIX` (`'legion'`)
- `src/bus/memory.js` → `createMemoryBus()` (NATS-style wildcard double; `*` = one token, `>` = trailing tokens)
- `src/consensus/vote.js` → `createVote({ agentId, stance, conviction, weight, rationale })`, `validateVote(vote)`
- `src/consensus/aggregate.js` → `evaluateRound(votes, { thetaV, quorum, holdBand })` → `{ S, V, kappa, converged, band }`
- `src/agents/technical/{config,gather,prompt,parse,index}.js` (Phase 1)
- `src/emit/plan.js` → `buildSignal(evalResult, { symbol, votes })` → `{ symbol, band, conviction, plan }`
- `src/emit/telegram.js` → `sendTelegram`, `formatSignal`
- `src/emit/emitter.js` → `createEmitter({ bus, repo, telegram, consensus, expectedAgents })` (Phase 1 — **rewritten** in Task 9)
- `src/db/repo.js` → `createCycle/addRound/addVote/addSignal/finishCycle`
- `src/orchestrator.js` → `createOrchestrator({ bus, repo })` → `{ kick(symbol) }` (unchanged)
- `src/config/index.js` → `loadConfig(env)` → `{ ..., consensus: { thetaV, quorum, maxRounds, holdBand } }`

**Message shapes (Phase 2):**

- Cycle / round-request: `{ cycleId, symbol, round, priorVotes?: Vote[] }` on `cycleSubject` (round 1 omits `priorVotes`; agents default it to `[]`)
- Vote envelope: `{ cycleId, symbol, round, vote: { agentId, stance, conviction, weight, rationale } }` on `voteSubject(t, r)`
- Constraint: `{ cycleId, symbol, round, constraint: { capConviction, blockBuy, reason } }` on `constraintSubject(t, r)`
- Consensus: `{ cycleId, symbol, band, conviction, plan }` on `consensusSubject(t)`

---

## File Structure (Phase 2 additions / changes)

```
legion/
  src/
    bus/
      subjects.js        # MODIFY: add constraintSubject(t,r), constraintWildcard()
    agents/
      parse.js           # NEW: shared parseVote (canonical)
      peers.js           # NEW: summarizePeers(priorVotes, selfId) -> dissent text
      format.js          # NEW: RESPONSE_SPEC + dissentBlock(peers)
      factory.js         # NEW: createAgent({ id, weight, gather, buildPrompt, bus, gunvest, provider })
      technical/
        parse.js         # MODIFY: re-export from ../parse.js
        prompt.js        # MODIFY: (symbol, data, peers) using format helpers
        index.js         # MODIFY: delegate to createAgent
      news/
        config.js prompt.js gather.js index.js
      social/
        config.js prompt.js gather.js index.js
      contrarian/
        config.js prompt.js gather.js index.js   # gather merges sentiment + feeds panel
    data/
      gunvest.js         # MODIFY: add getStockFearGreed()
      feeds/             # NEW: contrarian crowd-positioning feeds (legion-side)
        cache.js http.js cboe.js aaii.js naaim.js finnhub.js index.js
    config/
      index.js           # MODIFY: add finnhubApiKey
    risk/
      gather.js          # NEW: gatherRisk(gunvest, symbol)
      rules.js           # NEW: computeConstraint(data)
      apply.js           # NEW: applyRiskConstraint(signal, constraint)
      manager.js         # NEW: createRiskManager({ bus, gunvest })
    emit/
      emitter.js         # REWRITE: per-round keying, risk-aware, iteration, per-round persist
    db/
      repo.js            # MODIFY: add listEnabledTickers()
    scheduler.js         # NEW: createScheduler({ orchestrator, repo })
    run/
      agent-news.js agent-social.js agent-contrarian.js risk.js scheduler.js  # NEW
      emitter.js         # MODIFY: expectedAgents + riskEnabled from env
  test/
    bus/subjects.constraint.test.js
    agents/parse.test.js
    agents/peers.test.js
    agents/factory.test.js
    agents/news/{gather,prompt}.test.js
    agents/social/{gather,prompt}.test.js
    agents/contrarian/{gather,prompt}.test.js
    risk/{rules,apply,manager}.test.js
    emit/emitter.test.js          # REPLACES Phase 1 emitter test
    db/repo.tickers.test.js
    scheduler.test.js
    e2e/consensus.test.js
```

---

## Task 1: Constraint subjects

**Files:**

- Modify: `legion/src/bus/subjects.js`
- Test: `legion/test/bus/subjects.constraint.test.js`

- [ ] **Step 1: Write the failing test `test/bus/subjects.constraint.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { constraintSubject, constraintWildcard } from '../../src/bus/subjects.js';

describe('constraint subjects', () => {
  it('builds a per-ticker per-round constraint subject', () => {
    expect(constraintSubject('NVDA', 2)).toBe('legion.constraint.NVDA.2');
  });

  it('uppercases the ticker', () => {
    expect(constraintSubject('mu', 1)).toBe('legion.constraint.MU.1');
  });

  it('exposes a trailing wildcard for the emitter', () => {
    expect(constraintWildcard()).toBe('legion.constraint.>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bus/subjects.constraint.test.js`
Expected: FAIL — `constraintSubject is not a function` / undefined export.

- [ ] **Step 3: Append to `src/bus/subjects.js`**

Keep all existing exports unchanged; add:

```js
export function constraintSubject(ticker, round) {
  return `${PREFIX}.constraint.${ticker.toUpperCase()}.${round}`;
}

export function constraintWildcard() {
  return `${PREFIX}.constraint.>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bus/subjects.constraint.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bus/subjects.js test/bus/subjects.constraint.test.js
git commit -m "feat: add constraint subjects for risk manager"
```

---

## Task 2: Shared vote parser

**Files:**

- Create: `legion/src/agents/parse.js`
- Modify: `legion/src/agents/technical/parse.js` (re-export)
- Test: `legion/test/agents/parse.test.js`

Promotes Phase 1's technical parser to a shared module every agent uses. The technical module keeps a thin re-export so its Phase 1 test stays green.

- [ ] **Step 1: Write the failing test `test/agents/parse.test.js`**

````js
import { describe, it, expect } from 'vitest';
import { parseVote } from '../../src/agents/parse.js';

const ctx = { agentId: 'news', weight: 1.0 };

describe('shared parseVote', () => {
  it('parses a clean JSON object', () => {
    const res = parseVote('{"stance": 1, "conviction": 0.7, "rationale": "guidance raise"}', ctx);
    expect(res.ok).toBe(true);
    expect(res.vote).toEqual({
      agentId: 'news',
      stance: 1,
      conviction: 0.7,
      weight: 1.0,
      rationale: 'guidance raise',
    });
  });

  it('extracts JSON from fenced prose', () => {
    const res = parseVote(
      'call:\n```json\n{"stance": -1, "conviction": 0.4, "rationale": "soft"}\n```',
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.vote.stance).toBe(-1);
  });

  it('fails on no JSON', () => {
    const res = parseVote('no json', ctx);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('no JSON object found in LLM output');
  });

  it('defaults missing rationale to empty string', () => {
    const res = parseVote('{"stance": 0, "conviction": 0.2}', ctx);
    expect(res.ok).toBe(true);
    expect(res.vote.rationale).toBe('');
  });
});
````

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/parse.test.js`
Expected: FAIL — `Cannot find module '../../src/agents/parse.js'`.

- [ ] **Step 3: Write `src/agents/parse.js`**

```js
import { createVote, validateVote } from '../consensus/vote.js';

// Extracts the first JSON object from arbitrary LLM text (tolerates code
// fences / surrounding prose), maps it to a full vote, and validates it.
function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export function parseVote(text, { agentId, weight }) {
  const obj = extractJson(text);
  if (!obj) return { ok: false, vote: null, errors: ['no JSON object found in LLM output'] };

  const vote = createVote({
    agentId,
    stance: obj.stance,
    conviction: obj.conviction,
    weight,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
  });

  const { ok, errors } = validateVote(vote);
  return { ok, vote: ok ? vote : null, errors };
}
```

- [ ] **Step 4: Replace `src/agents/technical/parse.js` with a re-export**

```js
// Canonical parser now lives in ../parse.js (shared by all agents).
export { parseVote } from '../parse.js';
```

- [ ] **Step 5: Run tests to verify both pass**

Run: `npx vitest run test/agents/parse.test.js test/agents/technical/parse.test.js`
Expected: PASS (shared 4 + technical 5).

- [ ] **Step 6: Commit**

```bash
git add src/agents/parse.js src/agents/technical/parse.js test/agents/parse.test.js
git commit -m "refactor: promote vote parser to shared agents module"
```

---

## Task 3: Peer dissent summarizer

**Files:**

- Create: `legion/src/agents/peers.js`
- Test: `legion/test/agents/peers.test.js`

Turns a prior round's votes into a dissent block fed to each agent in round ≥ 2. Excludes the agent's own prior vote and orders by conviction so the strongest opposing voices lead.

- [ ] **Step 1: Write the failing test `test/agents/peers.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { summarizePeers } from '../../src/agents/peers.js';

const priorVotes = [
  { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
  { agentId: 'news', stance: -1, conviction: 0.5, weight: 1, rationale: 'soft guidance' },
  { agentId: 'social', stance: 1, conviction: 0.3, weight: 1, rationale: 'mild hype' },
];

describe('summarizePeers', () => {
  it('returns empty string when there are no peers', () => {
    expect(summarizePeers([], 'technical')).toBe('');
  });

  it("excludes the agent's own prior vote", () => {
    const text = summarizePeers(priorVotes, 'technical');
    expect(text).not.toContain('technical');
    expect(text).toContain('news');
    expect(text).toContain('social');
  });

  it('orders peers by conviction descending and labels the stance', () => {
    const text = summarizePeers(priorVotes, 'contrarian');
    const firstLine = text.split('\n')[0];
    expect(firstLine).toContain('technical');
    expect(firstLine).toContain('STRONG_BUY');
    expect(text).toContain('SELL');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/peers.test.js`
Expected: FAIL — `Cannot find module '../../src/agents/peers.js'`.

- [ ] **Step 3: Write `src/agents/peers.js`**

```js
const LABEL = {
  '-2': 'STRONG_SELL',
  '-1': 'SELL',
  0: 'HOLD',
  1: 'BUY',
  2: 'STRONG_BUY',
};

// Renders the prior round's opposing votes as a dissent block for round >= 2.
// Empty string when no peers (round 1 or single-agent), so prompts can skip it.
export function summarizePeers(priorVotes = [], selfId) {
  const others = priorVotes.filter((v) => v.agentId !== selfId);
  if (others.length === 0) return '';
  return others
    .slice()
    .sort((a, b) => b.conviction - a.conviction)
    .map(
      (v) =>
        `- ${v.agentId} voted ${LABEL[String(v.stance)]} (conviction ${v.conviction}): ${v.rationale}`,
    )
    .join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/peers.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agents/peers.js test/agents/peers.test.js
git commit -m "feat: add peer dissent summarizer for round iteration"
```

---

## Task 4: Shared agent factory (+ prompt format helpers)

**Files:**

- Create: `legion/src/agents/format.js`
- Create: `legion/src/agents/factory.js`
- Modify: `legion/src/agents/technical/prompt.js` (use format helpers, accept `peers`)
- Modify: `legion/src/agents/technical/index.js` (delegate to factory)
- Test: `legion/test/agents/factory.test.js`

The factory is the one runner every voting agent shares: subscribe cycles → `gather` → `buildPrompt(symbol, data, peers)` → `provider.generate` → `parseVote` → publish vote; abstain (HOLD/0) on parse failure or error. `format.js` centralizes the JSON response contract and the dissent block so all four prompts stay consistent.

- [ ] **Step 1: Write `src/agents/format.js`**

```js
// Shared prompt fragments so every agent asks for the same JSON contract and
// renders dissent the same way.
export const RESPONSE_SPEC = `Respond with ONE JSON object and nothing else:
{
  "stance": <integer from -2 to 2: -2 STRONG_SELL, -1 SELL, 0 HOLD, 1 BUY, 2 STRONG_BUY>,
  "conviction": <number from 0 to 1>,
  "rationale": "<one or two sentences>"
}`;

// Renders the dissent section for round >= 2. Empty string when no peers.
export function dissentBlock(peers) {
  if (!peers) return '';
  return `

Your peers in the prior round argued:
${peers}
Weigh their strongest opposing points honestly before re-voting.`;
}
```

- [ ] **Step 2: Write the failing test `test/agents/factory.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createAgent } from '../../src/agents/factory.js';
import { cycleSubject, voteSubject } from '../../src/bus/subjects.js';

function setup({ generateImpl, buildPrompt }) {
  const bus = createMemoryBus();
  const gunvest = { getThing: async () => ({ ok: true }) };
  const provider = { name: 'local', generate: vi.fn(generateImpl) };
  const agent = createAgent({
    id: 'news',
    weight: 1.3,
    gather: async (gv, symbol) => ({ symbol }),
    buildPrompt: buildPrompt ?? ((symbol) => ({ system: 'sys', prompt: `p ${symbol}` })),
    bus,
    gunvest,
    provider,
  });
  agent.start();
  return { bus, provider };
}

describe('createAgent', () => {
  it('publishes a parsed vote carrying the agent id and weight', async () => {
    const { bus } = setup({
      generateImpl: async () => '{"stance": 1, "conviction": 0.6, "rationale": "catalyst"}',
    });
    const votes = [];
    bus.subscribeJSON(voteSubject('NVDA', 1), (m) => votes.push(m));

    bus.publishJSON(cycleSubject('NVDA'), { cycleId: 3, symbol: 'NVDA', round: 1 });
    await vi.waitFor(() => expect(votes.length).toBe(1));

    expect(votes[0].vote).toMatchObject({
      agentId: 'news',
      weight: 1.3,
      stance: 1,
      conviction: 0.6,
    });
  });

  it('passes a dissent summary to buildPrompt on round >= 2', async () => {
    const buildPrompt = vi.fn((symbol) => ({ system: 's', prompt: 'p' }));
    const { bus } = setup({
      generateImpl: async () => '{"stance": 0, "conviction": 0.1, "rationale": "x"}',
      buildPrompt,
    });

    bus.publishJSON(cycleSubject('MU'), {
      cycleId: 9,
      symbol: 'MU',
      round: 2,
      priorVotes: [
        { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
        { agentId: 'news', stance: -1, conviction: 0.4, weight: 1, rationale: 'soft' },
      ],
    });
    await vi.waitFor(() => expect(buildPrompt).toHaveBeenCalled());

    const peersArg = buildPrompt.mock.calls[0][2];
    expect(peersArg).toContain('technical');
    expect(peersArg).not.toContain('news'); // own prior vote excluded
  });

  it('abstains with HOLD/0 when output is unparseable', async () => {
    const { bus } = setup({ generateImpl: async () => 'cannot decide' });
    const votes = [];
    bus.subscribeJSON(voteSubject('MU', 1), (m) => votes.push(m));

    bus.publishJSON(cycleSubject('MU'), { cycleId: 1, symbol: 'MU', round: 1 });
    await vi.waitFor(() => expect(votes.length).toBe(1));

    expect(votes[0].vote).toMatchObject({ agentId: 'news', stance: 0, conviction: 0, weight: 1.3 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/agents/factory.test.js`
Expected: FAIL — `Cannot find module '../../src/agents/factory.js'`.

- [ ] **Step 4: Write `src/agents/factory.js`**

```js
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
        vote = abstain(id, weight);
      }
    } catch (err) {
      logger.error(`[${id}] cycle error: ${err.message}`);
      vote = abstain(id, weight);
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

function abstain(id, weight) {
  return createVote({
    agentId: id,
    stance: 0,
    conviction: 0,
    weight,
    rationale: 'abstain (no usable signal)',
  });
}
```

- [ ] **Step 5: Rewrite `src/agents/technical/prompt.js` to use the format helpers**

```js
import { RESPONSE_SPEC, dissentBlock } from '../format.js';

const SYSTEM = `You are a professional technical analyst on a multi-agent trading desk.
You judge a stock purely on price action, trend, momentum, and volatility.
You are decisive but honest about uncertainty.`;

export function buildPrompt(symbol, data, peers = '') {
  const prompt = `Analyze ${symbol} from a technical standpoint.

Market data (JSON):
${JSON.stringify(data, null, 2)}${dissentBlock(peers)}

${RESPONSE_SPEC}`;
  return { system: SYSTEM, prompt };
}
```

- [ ] **Step 6: Rewrite `src/agents/technical/index.js` to delegate to the factory**

```js
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
```

- [ ] **Step 7: Run the factory + Phase 1 technical/prompt tests**

Run: `npx vitest run test/agents/factory.test.js test/agents/technical/`
Expected: PASS (factory 3 + Phase 1 technical prompt/gather/index/parse all still green).

- [ ] **Step 8: Commit**

```bash
git add src/agents/format.js src/agents/factory.js src/agents/technical/prompt.js src/agents/technical/index.js test/agents/factory.test.js
git commit -m "refactor: extract shared agent factory and prompt format helpers"
```

---

## Task 5: News / Catalyst agent

**Files:**

- Create: `legion/src/agents/news/config.js`
- Create: `legion/src/agents/news/gather.js`
- Create: `legion/src/agents/news/prompt.js`
- Create: `legion/src/agents/news/index.js`
- Test: `legion/test/agents/news/gather.test.js`, `legion/test/agents/news/prompt.test.js`

News/Catalyst folds in macro (spec §4: News + Macro/Geo). It pulls headlines for the ticker plus the macro snapshot. The runner is the shared factory, so only data + persona differ.

- [ ] **Step 1: Write `src/agents/news/config.js`**

```js
// w_i prior for the News/Catalyst agent. Slightly above 1.0: catalysts move
// price hard, but the agent is noisy, so it is not dominant.
export const newsConfig = {
  id: 'news',
  weight: 1.2,
  provider: 'local',
};
```

- [ ] **Step 2: Write the failing test `test/agents/news/gather.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { gather } from '../../../src/agents/news/gather.js';

describe('news gather', () => {
  it('pulls headlines and the macro snapshot, uppercasing the symbol', async () => {
    const seen = {};
    const gunvest = {
      getNews: async (s) => {
        seen.news = s;
        return [{ title: 'Q earnings beat' }];
      },
      getMacro: async () => ({ vix: 14 }),
    };
    const data = await gather(gunvest, 'nvda');
    expect(seen.news).toBe('NVDA');
    expect(data).toEqual({ news: [{ title: 'Q earnings beat' }], macro: { vix: 14 } });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/agents/news/gather.test.js`
Expected: FAIL — `Cannot find module '.../news/gather.js'`.

- [ ] **Step 4: Write `src/agents/news/gather.js`**

```js
// News/Catalyst inputs: ticker headlines + the macro snapshot (rates, VIX).
export async function gather(gunvest, symbol) {
  const sym = symbol.toUpperCase();
  const [news, macro] = await Promise.all([gunvest.getNews(sym), gunvest.getMacro()]);
  return { news, macro };
}
```

- [ ] **Step 5: Write the failing test `test/agents/news/prompt.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../../src/agents/news/prompt.js';

describe('news buildPrompt', () => {
  it('produces a catalyst persona and a JSON-bearing prompt', () => {
    const { system, prompt } = buildPrompt('NVDA', {
      news: [{ title: 'beat' }],
      macro: { vix: 14 },
    });
    expect(system).toMatch(/catalyst|news/i);
    expect(prompt).toContain('NVDA');
    expect(prompt).toMatch(/"stance"/);
    expect(prompt).toMatch(/"conviction"/);
  });

  it('includes the dissent block when peers are supplied', () => {
    const { prompt } = buildPrompt(
      'MU',
      { news: [], macro: {} },
      '- technical voted STRONG_BUY (conviction 0.9): breakout',
    );
    expect(prompt).toContain('prior round');
    expect(prompt).toContain('technical');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/agents/news/prompt.test.js`
Expected: FAIL — `Cannot find module '.../news/prompt.js'`.

- [ ] **Step 7: Write `src/agents/news/prompt.js`**

```js
import { RESPONSE_SPEC, dissentBlock } from '../format.js';

const SYSTEM = `You are a news and catalyst analyst on a multi-agent trading desk.
You weigh breaking news, earnings, guidance, analyst actions, and the macro backdrop
(rates, risk sentiment, VIX). You care about what changes the forward narrative.`;

export function buildPrompt(symbol, data, peers = '') {
  const prompt = `Assess ${symbol} from a news and catalyst standpoint.

Headlines and macro (JSON):
${JSON.stringify(data, null, 2)}${dissentBlock(peers)}

${RESPONSE_SPEC}`;
  return { system: SYSTEM, prompt };
}
```

- [ ] **Step 8: Write `src/agents/news/index.js`**

```js
import { createAgent } from '../factory.js';
import { gather } from './gather.js';
import { buildPrompt } from './prompt.js';

export function createNewsAgent({ bus, gunvest, provider, config, logger = console }) {
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
```

- [ ] **Step 9: Run the news tests**

Run: `npx vitest run test/agents/news/`
Expected: PASS (gather 1 + prompt 2). The runner is exercised end-to-end in Task 11.

- [ ] **Step 10: Commit**

```bash
git add src/agents/news test/agents/news
git commit -m "feat: add news/catalyst agent"
```

---

## Task 6: Social Sentiment agent

**Files:**

- Create: `legion/src/agents/social/config.js`
- Create: `legion/src/agents/social/gather.js`
- Create: `legion/src/agents/social/prompt.js`
- Create: `legion/src/agents/social/index.js`
- Test: `legion/test/agents/social/gather.test.js`, `legion/test/agents/social/prompt.test.js`

Social reads StockTwits/Reddit mood + volume via GunVest's sentiment endpoint. Lower prior weight (crowd is noisy and often wrong at extremes — the Contrarian exists partly to fade it).

- [ ] **Step 1: Write `src/agents/social/config.js`**

```js
// Lower prior: crowd sentiment is informative but noisy and herd-prone.
export const socialConfig = {
  id: 'social',
  weight: 0.8,
  provider: 'local',
};
```

- [ ] **Step 2: Write the failing test `test/agents/social/gather.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { gather } from '../../../src/agents/social/gather.js';

describe('social gather', () => {
  it('pulls sentiment for the uppercased symbol', async () => {
    let seen;
    const gunvest = {
      getSentiment: async (s) => {
        seen = s;
        return { score: 0.6, volume: 1200 };
      },
    };
    const data = await gather(gunvest, 'mu');
    expect(seen).toBe('MU');
    expect(data).toEqual({ sentiment: { score: 0.6, volume: 1200 } });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/agents/social/gather.test.js`
Expected: FAIL — `Cannot find module '.../social/gather.js'`.

- [ ] **Step 4: Write `src/agents/social/gather.js`**

```js
// Social inputs: crowd mood/volume from StockTwits + Reddit (via GunVest).
export async function gather(gunvest, symbol) {
  const sentiment = await gunvest.getSentiment(symbol.toUpperCase());
  return { sentiment };
}
```

- [ ] **Step 5: Write the failing test `test/agents/social/prompt.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../../src/agents/social/prompt.js';

describe('social buildPrompt', () => {
  it('produces a social-sentiment persona and JSON contract', () => {
    const { system, prompt } = buildPrompt('NVDA', { sentiment: { score: 0.6, volume: 1200 } });
    expect(system).toMatch(/social|sentiment|crowd/i);
    expect(prompt).toContain('NVDA');
    expect(prompt).toMatch(/"rationale"/);
  });

  it('includes dissent when peers are supplied', () => {
    const { prompt } = buildPrompt(
      'MU',
      { sentiment: {} },
      '- news voted SELL (conviction 0.5): soft',
    );
    expect(prompt).toContain('prior round');
    expect(prompt).toContain('news');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/agents/social/prompt.test.js`
Expected: FAIL — `Cannot find module '.../social/prompt.js'`.

- [ ] **Step 7: Write `src/agents/social/prompt.js`**

```js
import { RESPONSE_SPEC, dissentBlock } from '../format.js';

const SYSTEM = `You are a social sentiment analyst on a multi-agent trading desk.
You read retail mood and message volume from StockTwits and Reddit. You know the
crowd can front-run moves but is unreliable at euphoric or panicked extremes.`;

export function buildPrompt(symbol, data, peers = '') {
  const prompt = `Assess ${symbol} from a social sentiment standpoint.

Sentiment data (JSON):
${JSON.stringify(data, null, 2)}${dissentBlock(peers)}

${RESPONSE_SPEC}`;
  return { system: SYSTEM, prompt };
}
```

- [ ] **Step 8: Write `src/agents/social/index.js`**

```js
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
```

- [ ] **Step 9: Run the social tests**

Run: `npx vitest run test/agents/social/`
Expected: PASS (gather 1 + prompt 2).

- [ ] **Step 10: Commit**

```bash
git add src/agents/social test/agents/social
git commit -m "feat: add social sentiment agent"
```

---

## Task 7: Contrarian agent + real crowd-positioning feeds

**Files:**

- Create: `legion/src/data/feeds/{cache,http,cboe,aaii,naaim,finnhub,index}.js`
- Modify: `legion/src/data/gunvest.js` (add `getStockFearGreed`)
- Modify: `legion/src/config/index.js` (add `finnhubApiKey`)
- Create: `legion/src/agents/contrarian/{config,gather,prompt,index}.js`
- Test: `legion/test/data/feeds/*.test.js`, `legion/test/agents/contrarian/{gather,prompt}.test.js`,
  add a `getStockFearGreed` case to `legion/test/data/gunvest.test.js`

The Contrarian fades extremes using **real** positioning data (spec §4.1), fetched legion-side and
degrading gracefully when a source is down. CNN Fear & Greed (equities) and VIX are already served
by GunVest (`/api/sentiment/stock/fear-greed`, `/api/macro`) so they are **reused** from the GunVest
client — GunVest stays the source of truth (spec §2). CBOE put/call, AAII bull/bear, NAAIM exposure,
and Finnhub short interest are **not** on GunVest, so a new `src/data/feeds/` module fetches them.
Each source is isolated, TTL-cached, and returns a value **or `null`** — a dead upstream never
blocks or crashes the agent. Its persona uses the **peers** dissent block to argue against the
_forming_ consensus, so it is most active in round ≥ 2.

**Free-source reality (2026):** Finnhub short interest is free (needs `FINNHUB_API_KEY`, copy from
GunVest). CBOE's public put/call CSV is stale and the live daily series has no confirmed free JSON;
AAII/NAAIM have no confirmed free machine endpoint. So `cboe`/`aaii`/`naaim` ship as best-effort
fetchers (parse logic ready, return `null` until a source URL is supplied) — the pluggable +
graceful-degrade design the spec calls for. F&G, VIX, and short interest are live now.

### 7a. Feeds module (`src/data/feeds/`)

- `cache.js` — `createTtlCache(now?)` → `{ getOrFetch(key, ttlMs, fn) }`. Market-wide feeds must not
  be re-hit per ticker during a scheduler sweep.
- `http.js` — `getJson`/`getText` with an `AbortController` timeout + browser headers; throw on
  non-2xx (callers convert to `null`).
- `finnhub.js` — `fetchShortInterest({ symbol, apiKey, fetchImpl })` → `{ shortInterest, date } |
  null` (null when no key / non-200 / empty). Crowded shorts = squeeze fuel = contrarian-bullish.
- `cboe.js` — `fetchPutCall({ fetchImpl, url? })` → `{ ratio, date } | null`, parses the last data
  row of CBOE's put/call CSV. High ratio = fear = contrarian-bullish.
- `aaii.js` — `fetchAaii({ fetchImpl, url })` → `{ bullish, bearish, neutral, spread } | null`
  (null without a `url`). High bullish share = greed = contrarian-bearish.
- `naaim.js` — `fetchNaaim({ fetchImpl, url })` → `{ exposure, date } | null` (null without a `url`).
  High exposure = crowded long = contrarian-bearish.
- `index.js` — `createContrarianFeeds({ gunvest, finnhubApiKey, fetchImpl?, cache?, sources?, logger? })`
  exposing `gather(symbol)` → `{ fearGreed, vix, putCall, aaii, naaim, shortInterest }`. Runs all six
  via `Promise.all`, each wrapped in a `safe()` that returns `null` on throw and behind
  `cache.getOrFetch` (F&G/VIX ~1h, put/call ~6h, AAII/NAAIM/short ~24h; short interest keyed per
  symbol). `fearGreed`/`vix` come from `gunvest.getStockFearGreed()`/`getMacro().vix`.

Tests: one `*.test.js` per source (fixture via injected `fetchImpl`; null on non-ok / no key / no
url), `cache.test.js` (TTL hit/expiry), and `index.test.js` (merges six keys; a single failing
source → that key `null`, others present; market-wide feeds cached across tickers).

### 7b. GunVest client + config

- `src/data/gunvest.js`: add `getStockFearGreed: () => get('/api/sentiment/stock/fear-greed')`.
- `src/config/index.js`: add `finnhubApiKey: env.FINNHUB_API_KEY || ''`.

### 7c. Contrarian agent

```js
// config.js — modest prior so it tempers, not dominates.
export const contrarianConfig = { id: 'contrarian', weight: 0.9, provider: 'local' };
```

```js
// gather.js — per-ticker sentiment (GunVest) + the market-wide positioning panel (feeds).
export async function gather(gunvest, symbol, feeds) {
  const sym = symbol.toUpperCase();
  const [sentiment, positioning] = await Promise.all([gunvest.getSentiment(sym), feeds.gather(sym)]);
  return { sentiment, ...positioning };
}
```

```js
// prompt.js — persona names each real feed's contrarian meaning and tolerates null fields.
import { RESPONSE_SPEC, dissentBlock } from '../format.js';

const SYSTEM = `You are the contrarian on a multi-agent trading desk — the desk's devil's advocate.
You fade crowded extremes using real positioning data:
- High CNN Fear & Greed, high AAII bullish share, or high NAAIM exposure = crowded greed -> lean bearish.
- High VIX, high CBOE put/call ratio, panicked sentiment, or crowded short interest = fear/squeeze fuel -> lean bullish.
Any field may be null when a feed is unavailable; ignore nulls and reason over what is present.
When your peers are converging, stress-test that consensus with the strongest opposing case the data supports.`;

export function buildPrompt(symbol, data, peers = '') {
  const prompt = `Take the contrarian view on ${symbol}.

Crowd-positioning panel (JSON; null = feed unavailable):
${JSON.stringify(data, null, 2)}${dissentBlock(peers)}

${RESPONSE_SPEC}`;
  return { system: SYSTEM, prompt };
}
```

```js
// index.js — bind the injected feeds client into gather; factory runner unchanged.
import { createAgent } from '../factory.js';
import { gather } from './gather.js';
import { buildPrompt } from './prompt.js';

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
```

The entrypoint (`src/run/agent-contrarian.js`, Task 12) builds the real feeds client:
`const feeds = createContrarianFeeds({ gunvest, finnhubApiKey: cfg.finnhubApiKey });`

- [ ] **Run the contrarian + feeds tests**

Run: `npx vitest run test/data/feeds/ test/agents/contrarian/ test/data/gunvest.test.js`
Expected: PASS (feeds 18 + contrarian gather 1 / prompt 3 + gunvest incl. F&G).

- [ ] **Commit**

```bash
git add src/data/feeds src/data/gunvest.js src/config/index.js src/agents/contrarian \
  test/data/feeds test/agents/contrarian test/data/gunvest.test.js
git commit -m "feat: add contrarian agent with real crowd-positioning feeds"
```

---

## Task 8: Risk Manager constraint node

**Files:**

- Create: `legion/src/risk/rules.js`
- Create: `legion/src/risk/apply.js`
- Create: `legion/src/risk/gather.js`
- Create: `legion/src/risk/manager.js`
- Test: `legion/test/risk/rules.test.js`, `legion/test/risk/apply.test.js`, `legion/test/risk/manager.test.js`

The Risk Manager is **non-voting** (spec §3.8): it never enters the consensus math. It deterministically computes a constraint from volatility/macro and the emitter applies it to the **converged** signal — capping conviction or blocking a new long, never flipping direction.

- [ ] **Step 1: Write the failing test `test/risk/rules.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { computeConstraint } from '../../src/risk/rules.js';

describe('computeConstraint', () => {
  it('imposes no cap in calm conditions', () => {
    const c = computeConstraint({ vix: 14, changePercent: 1.2 });
    expect(c).toEqual({ capConviction: 1, blockBuy: false, reason: 'no risk flags' });
  });

  it('caps conviction when VIX is elevated', () => {
    const c = computeConstraint({ vix: 32, changePercent: 1 });
    expect(c.capConviction).toBe(0.5);
    expect(c.blockBuy).toBe(false);
    expect(c.reason).toMatch(/VIX/);
  });

  it('blocks new longs when VIX is extreme', () => {
    const c = computeConstraint({ vix: 42, changePercent: 1 });
    expect(c.blockBuy).toBe(true);
  });

  it('caps harder on an outsized daily move (chasing risk)', () => {
    const c = computeConstraint({ vix: 15, changePercent: -9.5 });
    expect(c.capConviction).toBe(0.4);
    expect(c.reason).toMatch(/move/);
  });

  it('takes the tightest cap when multiple flags fire', () => {
    const c = computeConstraint({ vix: 33, changePercent: 12 });
    expect(c.capConviction).toBe(0.4); // min(0.5, 0.4)
  });

  it('treats missing fields as calm', () => {
    expect(computeConstraint({})).toEqual({
      capConviction: 1,
      blockBuy: false,
      reason: 'no risk flags',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/risk/rules.test.js`
Expected: FAIL — `Cannot find module '../../src/risk/rules.js'`.

- [ ] **Step 3: Write `src/risk/rules.js`**

```js
// Deterministic risk rules. Returns the tightest applicable conviction cap and
// whether new longs are blocked, with a human-readable reason. Pure function —
// no LLM, fully unit-testable.
const VIX_ELEVATED = 30;
const VIX_EXTREME = 40;
const OUTSIZED_MOVE_PCT = 8;

export function computeConstraint(data) {
  const vix = Number(data.vix ?? 0);
  const move = Math.abs(Number(data.changePercent ?? 0));
  const caps = [];
  const reasons = [];
  let blockBuy = false;

  if (vix >= VIX_ELEVATED) {
    caps.push(0.5);
    reasons.push(`elevated VIX ${vix}`);
  }
  if (vix >= VIX_EXTREME) {
    blockBuy = true;
    reasons.push(`extreme VIX ${vix} blocks new longs`);
  }
  if (move >= OUTSIZED_MOVE_PCT) {
    caps.push(0.4);
    reasons.push(`outsized daily move ${move}%`);
  }

  return {
    capConviction: caps.length ? Math.min(...caps) : 1,
    blockBuy,
    reason: reasons.join('; ') || 'no risk flags',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/risk/rules.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing test `test/risk/apply.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { applyRiskConstraint } from '../../src/risk/apply.js';

const baseSignal = {
  symbol: 'NVDA',
  band: 'STRONG_BUY',
  conviction: 0.9,
  plan: { horizon: 'swing', rationales: [] },
};

describe('applyRiskConstraint', () => {
  it('returns the signal unchanged when there is no constraint', () => {
    expect(applyRiskConstraint(baseSignal, null)).toBe(baseSignal);
  });

  it('records the reason without changing a within-cap signal', () => {
    const out = applyRiskConstraint(
      { ...baseSignal, conviction: 0.3 },
      { capConviction: 0.5, blockBuy: false, reason: 'elevated VIX 31' },
    );
    expect(out.conviction).toBe(0.3);
    expect(out.band).toBe('STRONG_BUY');
    expect(out.plan.riskReason).toBe('elevated VIX 31');
    expect(out.plan.riskCapped).toBeUndefined();
  });

  it('caps conviction above the cap', () => {
    const out = applyRiskConstraint(baseSignal, {
      capConviction: 0.5,
      blockBuy: false,
      reason: 'elevated VIX 31',
    });
    expect(out.conviction).toBe(0.5);
    expect(out.plan.riskCapped).toBe(true);
    expect(out.band).toBe('STRONG_BUY'); // direction preserved
  });

  it('downgrades a buy to HOLD when new longs are blocked', () => {
    const out = applyRiskConstraint(baseSignal, {
      capConviction: 1,
      blockBuy: true,
      reason: 'extreme VIX 42',
    });
    expect(out.band).toBe('HOLD');
    expect(out.conviction).toBe(0);
    expect(out.plan.riskBlocked).toBe(true);
  });

  it('does not block a sell signal', () => {
    const sell = { ...baseSignal, band: 'STRONG_SELL', conviction: 0.8 };
    const out = applyRiskConstraint(sell, {
      capConviction: 1,
      blockBuy: true,
      reason: 'extreme VIX 42',
    });
    expect(out.band).toBe('STRONG_SELL');
    expect(out.plan.riskBlocked).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/risk/apply.test.js`
Expected: FAIL — `Cannot find module '../../src/risk/apply.js'`.

- [ ] **Step 7: Write `src/risk/apply.js`**

```js
// Applies a risk constraint to a converged signal. Constrains magnitude/entry
// only — never flips direction (leaderless purity: risk constrains, it does not
// decide). Returns a new signal; the input is left untouched.
export function applyRiskConstraint(signal, constraint) {
  if (!constraint) return signal;

  const plan = { ...signal.plan, riskReason: constraint.reason };
  let { band, conviction } = signal;

  if (constraint.blockBuy && (band === 'BUY' || band === 'STRONG_BUY')) {
    band = 'HOLD';
    conviction = 0;
    plan.riskBlocked = true;
  } else if (conviction > constraint.capConviction) {
    conviction = constraint.capConviction;
    plan.riskCapped = true;
  }

  return { ...signal, band, conviction, plan };
}
```

- [ ] **Step 8: Write `src/risk/gather.js`**

```js
// Risk inputs: the day's move (chasing risk) + macro fear gauge (VIX).
export async function gatherRisk(gunvest, symbol) {
  const sym = symbol.toUpperCase();
  const [price, macro] = await Promise.all([gunvest.getPrice(sym), gunvest.getMacro()]);
  return { changePercent: price?.changePercent, vix: macro?.vix };
}
```

- [ ] **Step 9: Write the failing test `test/risk/manager.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createRiskManager } from '../../src/risk/manager.js';
import { cycleSubject, constraintSubject } from '../../src/bus/subjects.js';

describe('createRiskManager', () => {
  it('publishes a deterministic constraint for each cycle round', async () => {
    const bus = createMemoryBus();
    const gunvest = {
      getPrice: async () => ({ changePercent: 1 }),
      getMacro: async () => ({ vix: 33 }),
    };
    const msgs = [];
    bus.subscribeJSON(constraintSubject('NVDA', 1), (m) => msgs.push(m));

    createRiskManager({ bus, gunvest }).start();
    bus.publishJSON(cycleSubject('NVDA'), { cycleId: 5, symbol: 'NVDA', round: 1 });

    await vi.waitFor(() => expect(msgs.length).toBe(1));
    expect(msgs[0]).toMatchObject({
      cycleId: 5,
      symbol: 'NVDA',
      round: 1,
      constraint: { capConviction: 0.5, blockBuy: false },
    });
  });

  it('emits a permissive constraint when risk data is unavailable', async () => {
    const bus = createMemoryBus();
    const gunvest = {
      getPrice: async () => {
        throw new Error('down');
      },
      getMacro: async () => ({ vix: 13 }),
    };
    const msgs = [];
    bus.subscribeJSON(constraintSubject('MU', 1), (m) => msgs.push(m));

    createRiskManager({ bus, gunvest, logger: { error() {}, warn() {} } }).start();
    bus.publishJSON(cycleSubject('MU'), { cycleId: 6, symbol: 'MU', round: 1 });

    await vi.waitFor(() => expect(msgs.length).toBe(1));
    expect(msgs[0].constraint).toEqual({
      capConviction: 1,
      blockBuy: false,
      reason: 'risk data unavailable',
    });
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run test/risk/manager.test.js`
Expected: FAIL — `Cannot find module '../../src/risk/manager.js'`.

- [ ] **Step 11: Write `src/risk/manager.js`**

```js
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
```

- [ ] **Step 12: Run the risk tests**

Run: `npx vitest run test/risk/`
Expected: PASS (rules 6 + apply 5 + manager 2).

- [ ] **Step 13: Commit**

```bash
git add src/risk test/risk
git commit -m "feat: add risk manager constraint node"
```

---

## Task 9: Emitter v2 — per-round keying, risk, and iteration

**Files:**

- Rewrite: `legion/src/emit/emitter.js`
- Replace: `legion/test/emit/emitter.test.js` (Phase 1 test is superseded)

This is the heart of Phase 2. The emitter now keys pending state by `${cycleId}:${round}` (not just `cycleId`), waits for `expectedAgents` votes **and** (when `riskEnabled`) the round's constraint, persists **every** round, then either:

- **finalizes** (converged, or `round >= maxRounds`): build signal → apply risk → persist signal → finish cycle → Telegram → publish consensus; or
- **iterates**: republish `cycleSubject(symbol)` with `round+1` and the round's votes as `priorVotes`, so agents re-vote with dissent.

`consensus` carries `{ thetaV, quorum, holdBand, maxRounds }` (from `loadConfig().consensus`). `evaluateRound` uses the first three; the emitter uses `maxRounds`.

- [ ] **Step 1: Replace `test/emit/emitter.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createEmitter } from '../../src/emit/emitter.js';
import {
  voteSubject,
  constraintSubject,
  cycleSubject,
  consensusSubject,
} from '../../src/bus/subjects.js';

const consensus = { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5, maxRounds: 3 };

function fakeRepo() {
  return {
    addRound: vi.fn(async () => 10),
    addVote: vi.fn(async () => 100),
    addSignal: vi.fn(async () => 1000),
    finishCycle: vi.fn(async () => {}),
  };
}

function emitVote(bus, { cycleId, symbol, round, vote }) {
  bus.publishJSON(voteSubject(symbol, round), { cycleId, symbol, round, vote });
}

describe('createEmitter (v2)', () => {
  it('finalizes a converged round: persists, notifies, publishes consensus', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const telegram = vi.fn(async () => {});
    const out = [];
    bus.subscribeJSON(consensusSubject('NVDA'), (m) => out.push(m));

    createEmitter({ bus, repo, telegram, consensus, expectedAgents: 2 }).start();

    emitVote(bus, {
      cycleId: 1,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
    });
    emitVote(bus, {
      cycleId: 1,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'news', stance: 2, conviction: 0.8, weight: 1, rationale: 'beat' },
    });

    await vi.waitFor(() => expect(telegram).toHaveBeenCalledTimes(1));
    expect(repo.addRound).toHaveBeenCalledTimes(1);
    expect(repo.addVote).toHaveBeenCalledTimes(2);
    expect(repo.finishCycle).toHaveBeenCalledWith(1, 'converged');
    expect(out[0]).toMatchObject({ cycleId: 1, symbol: 'NVDA', band: 'STRONG_BUY' });
  });

  it('iterates: a split round 1 republishes a round 2 request carrying priorVotes', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const requests = [];
    bus.subscribeJSON(cycleSubject('MU'), (m) => requests.push(m));

    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus,
      expectedAgents: 2,
    }).start();

    // opposed strong votes -> high dispersion -> not converged
    emitVote(bus, {
      cycleId: 2,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 1, weight: 1, rationale: 'up' },
    });
    emitVote(bus, {
      cycleId: 2,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'news', stance: -2, conviction: 1, weight: 1, rationale: 'down' },
    });

    await vi.waitFor(() => expect(requests.length).toBe(1));
    expect(requests[0]).toMatchObject({ cycleId: 2, symbol: 'MU', round: 2 });
    expect(requests[0].priorVotes).toHaveLength(2);
    expect(repo.addRound).toHaveBeenCalledTimes(1); // round 1 persisted
    expect(repo.finishCycle).not.toHaveBeenCalled();
  });

  it('emits no_consensus when the final round is still split', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const onePassConsensus = { ...consensus, maxRounds: 1 };

    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus: onePassConsensus,
      expectedAgents: 2,
    }).start();

    emitVote(bus, {
      cycleId: 3,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 1, weight: 1, rationale: 'up' },
    });
    emitVote(bus, {
      cycleId: 3,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'news', stance: -2, conviction: 1, weight: 1, rationale: 'down' },
    });

    await vi.waitFor(() => expect(repo.finishCycle).toHaveBeenCalledWith(3, 'no_consensus'));
  });

  it('waits for the risk constraint before finalizing and applies it', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const out = [];
    bus.subscribeJSON(consensusSubject('NVDA'), (m) => out.push(m));

    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus,
      expectedAgents: 1,
      riskEnabled: true,
    }).start();

    // vote arrives first — must NOT finalize yet (no constraint)
    emitVote(bus, {
      cycleId: 4,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
    });
    expect(repo.finishCycle).not.toHaveBeenCalled();

    bus.publishJSON(constraintSubject('NVDA', 1), {
      cycleId: 4,
      symbol: 'NVDA',
      round: 1,
      constraint: { capConviction: 0.5, blockBuy: false, reason: 'elevated VIX 31' },
    });

    await vi.waitFor(() => expect(repo.finishCycle).toHaveBeenCalledWith(4, 'converged'));
    expect(out[0].conviction).toBe(0.5); // capped
    expect(out[0].plan.riskCapped).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/emit/emitter.test.js`
Expected: FAIL — current Phase 1 emitter lacks per-round keying / constraint handling / iteration.

- [ ] **Step 3: Rewrite `src/emit/emitter.js`**

```js
import {
  voteWildcard,
  constraintWildcard,
  cycleSubject,
  consensusSubject,
} from '../bus/subjects.js';
import { evaluateRound } from '../consensus/aggregate.js';
import { buildSignal } from './plan.js';
import { applyRiskConstraint } from '../risk/apply.js';
import { formatSignal } from './telegram.js';

// Collects votes (+ optional risk constraint) per (cycleId, round). When the
// round is complete it persists the round, then either finalizes (converged or
// round cap) or republishes the cycle for another round with dissent.
export function createEmitter({
  bus,
  repo,
  telegram,
  consensus,
  expectedAgents,
  riskEnabled = false,
  logger = console,
}) {
  const rounds = new Map(); // `${cycleId}:${round}` -> { symbol, round, votes, constraint }

  function key(cycleId, round) {
    return `${cycleId}:${round}`;
  }

  function touch(cycleId, round, symbol) {
    const k = key(cycleId, round);
    if (!rounds.has(k)) rounds.set(k, { symbol, round, votes: [], constraint: null });
    return { k, entry: rounds.get(k) };
  }

  function ready(entry) {
    return entry.votes.length >= expectedAgents && (!riskEnabled || entry.constraint !== null);
  }

  async function process(cycleId, k, entry) {
    rounds.delete(k); // guard against double-finalize
    const result = evaluateRound(entry.votes, consensus);
    const roundId = await repo.addRound(cycleId, entry.round, result);
    for (const v of entry.votes) await repo.addVote(roundId, v);

    const isFinal = result.converged || entry.round >= consensus.maxRounds;
    if (!isFinal) {
      bus.publishJSON(cycleSubject(entry.symbol), {
        cycleId,
        symbol: entry.symbol,
        round: entry.round + 1,
        priorVotes: entry.votes,
      });
      return;
    }

    let signal = buildSignal(result, { symbol: entry.symbol, votes: entry.votes });
    if (riskEnabled) signal = applyRiskConstraint(signal, entry.constraint);
    await repo.addSignal(cycleId, signal);
    await repo.finishCycle(cycleId, result.converged ? 'converged' : 'no_consensus');

    try {
      await telegram(formatSignal(signal));
    } catch (err) {
      logger.error(`[emitter] telegram failed: ${err.message}`);
    }
    bus.publishJSON(consensusSubject(entry.symbol), { cycleId, ...signal });
  }

  return {
    start() {
      bus.subscribeJSON(voteWildcard(), (msg) => {
        const { cycleId, symbol, round, vote } = msg;
        const { k, entry } = touch(cycleId, round, symbol);
        entry.votes.push(vote);
        if (ready(entry)) process(cycleId, k, entry);
      });
      bus.subscribeJSON(constraintWildcard(), (msg) => {
        const { cycleId, symbol, round, constraint } = msg;
        const { k, entry } = touch(cycleId, round, symbol);
        entry.constraint = constraint;
        if (ready(entry)) process(cycleId, k, entry);
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/emit/emitter.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/emit/emitter.js test/emit/emitter.test.js
git commit -m "feat: rewrite emitter for multi-round consensus and risk constraint"
```

---

## Task 10: Multi-ticker scheduling

**Files:**

- Modify: `legion/src/db/repo.js` (add `listEnabledTickers`)
- Create: `legion/src/scheduler.js`
- Test: `legion/test/db/repo.tickers.test.js`, `legion/test/scheduler.test.js`

The scheduler reads enabled tickers from the `legion.tickers` table and kicks a cycle for each. A failed kick on one ticker must not abort the rest.

- [ ] **Step 1: Write the failing test `test/db/repo.tickers.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createRepo } from '../../src/db/repo.js';
import { createDb } from '../../src/db/client.js';

describe('repo.listEnabledTickers', () => {
  it('returns the enabled ticker symbols', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ symbol: 'NVDA' }, { symbol: 'MU' }] })),
    };
    const repo = createRepo(createDb(pool));
    const symbols = await repo.listEnabledTickers();
    expect(symbols).toEqual(['NVDA', 'MU']);
    const [text] = pool.query.mock.calls[0];
    expect(text).toMatch(/SELECT symbol FROM legion\.tickers/);
    expect(text).toMatch(/enabled/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/repo.tickers.test.js`
Expected: FAIL — `repo.listEnabledTickers is not a function`.

- [ ] **Step 3: Add `listEnabledTickers` to `src/db/repo.js`**

Add this method inside the object returned by `createRepo` (keep all existing methods):

```js
    async listEnabledTickers() {
      const { rows } = await db.query(
        `SELECT symbol FROM legion.tickers WHERE enabled = true ORDER BY symbol`,
      );
      return rows.map((r) => r.symbol);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/repo.tickers.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Write the failing test `test/scheduler.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createScheduler } from '../src/scheduler.js';

describe('createScheduler', () => {
  it('kicks every enabled ticker once', async () => {
    const orchestrator = { kick: vi.fn(async () => 1) };
    const repo = { listEnabledTickers: vi.fn(async () => ['NVDA', 'MU']) };
    const kicked = await createScheduler({ orchestrator, repo }).runOnce();
    expect(kicked).toEqual(['NVDA', 'MU']);
    expect(orchestrator.kick).toHaveBeenCalledWith('NVDA');
    expect(orchestrator.kick).toHaveBeenCalledWith('MU');
  });

  it('continues past a failing ticker', async () => {
    const orchestrator = {
      kick: vi.fn(async (s) => {
        if (s === 'NVDA') throw new Error('boom');
        return 1;
      }),
    };
    const repo = { listEnabledTickers: vi.fn(async () => ['NVDA', 'MU']) };
    await createScheduler({ orchestrator, repo, logger: { error() {}, warn() {} } }).runOnce();
    expect(orchestrator.kick).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/scheduler.test.js`
Expected: FAIL — `Cannot find module '../src/scheduler.js'`.

- [ ] **Step 7: Write `src/scheduler.js`**

```js
// Reads enabled tickers and kicks a cycle for each. Pure orchestration — no
// consensus decision. One ticker's failure does not abort the batch.
export function createScheduler({ orchestrator, repo, logger = console }) {
  return {
    async runOnce() {
      const symbols = await repo.listEnabledTickers();
      for (const symbol of symbols) {
        try {
          await orchestrator.kick(symbol);
        } catch (err) {
          logger.error(`[scheduler] kick ${symbol} failed: ${err.message}`);
        }
      }
      return symbols;
    },
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/scheduler.test.js`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add src/db/repo.js src/scheduler.js test/db/repo.tickers.test.js test/scheduler.test.js
git commit -m "feat: add multi-ticker scheduler"
```

---

## Task 11: End-to-end multi-agent consensus test

**Files:**

- Test: `legion/test/e2e/consensus.test.js`

Runs the full gestalt over the in-memory bus: orchestrator → 4 voting agents (stubbed providers) + Risk Manager → emitter. Asserts a converged signal flows through with risk applied, and a separate scenario asserts iteration then convergence across two rounds.

- [ ] **Step 1: Write the test `test/e2e/consensus.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createOrchestrator } from '../../src/orchestrator.js';
import { createAgent } from '../../src/agents/factory.js';
import { createRiskManager } from '../../src/risk/manager.js';
import { createEmitter } from '../../src/emit/emitter.js';

const consensus = { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5, maxRounds: 3 };

// A stub voting agent that always returns a fixed stance/conviction.
function stubAgent(bus, gunvest, { id, weight, stance, conviction }) {
  const provider = {
    name: 'stub',
    generate: async () =>
      `{"stance": ${stance}, "conviction": ${conviction}, "rationale": "${id} says ${stance}"}`,
  };
  return createAgent({
    id,
    weight,
    gather: async () => ({}),
    buildPrompt: () => ({ system: 's', prompt: 'p' }),
    bus,
    gunvest,
    provider,
  });
}

function fakeRepo(sink) {
  return {
    createCycle: vi.fn(async () => 1),
    addRound: vi.fn(async () => 10),
    addVote: vi.fn(async () => 100),
    addSignal: vi.fn(async (cycleId, signal) => {
      sink.signals.push(signal);
      return 1000;
    }),
    finishCycle: vi.fn(async (cycleId, status) => {
      sink.status = status;
    }),
  };
}

describe('Legion Phase 2 consensus', () => {
  it('reaches converged BUY consensus with the risk constraint applied', async () => {
    const bus = createMemoryBus();
    const sink = { signals: [], status: null };
    const repo = fakeRepo(sink);
    const telegram = vi.fn(async () => {});
    const gunvest = {
      getPrice: async () => ({ changePercent: 1 }),
      getMacro: async () => ({ vix: 33 }), // -> capConviction 0.5
      getNews: async () => [],
      getSentiment: async () => ({ score: 0.5 }),
    };

    // 3 buys + 1 mild buy -> quorum on the buy side, low dispersion -> converge
    stubAgent(bus, gunvest, { id: 'technical', weight: 1.0, stance: 2, conviction: 0.9 }).start();
    stubAgent(bus, gunvest, { id: 'news', weight: 1.2, stance: 1, conviction: 0.8 }).start();
    stubAgent(bus, gunvest, { id: 'social', weight: 0.8, stance: 1, conviction: 0.6 }).start();
    stubAgent(bus, gunvest, { id: 'contrarian', weight: 0.9, stance: 1, conviction: 0.4 }).start();
    createRiskManager({ bus, gunvest }).start();

    createEmitter({ bus, repo, telegram, consensus, expectedAgents: 4, riskEnabled: true }).start();

    const orch = createOrchestrator({ bus, repo });
    await orch.kick('NVDA');

    await vi.waitFor(() => expect(telegram).toHaveBeenCalledTimes(1));
    expect(sink.status).toBe('converged');
    expect(sink.signals).toHaveLength(1);
    expect(['BUY', 'STRONG_BUY']).toContain(sink.signals[0].band);
    expect(sink.signals[0].conviction).toBeLessThanOrEqual(0.5); // risk cap
    expect(sink.signals[0].plan.riskReason).toMatch(/VIX/);
  });

  it('iterates to a second round when round 1 is split, then converges', async () => {
    const bus = createMemoryBus();
    const sink = { signals: [], status: null };
    const repo = fakeRepo(sink);
    const gunvest = {
      getPrice: async () => ({ changePercent: 1 }),
      getMacro: async () => ({ vix: 14 }),
      getNews: async () => [],
      getSentiment: async () => ({ score: 0.5 }),
    };

    // Two agents flip from a split in round 1 to agreement in round 2 once they
    // see peer dissent (priorVotes present).
    function flipAgent(id, weight, round1Stance) {
      const provider = {
        name: 'stub',
        generate: async ({ prompt }) => {
          const stance = prompt.includes('prior round') ? 1 : round1Stance;
          return `{"stance": ${stance}, "conviction": 0.8, "rationale": "${id}"}`;
        },
      };
      return createAgent({
        id,
        weight,
        gather: async () => ({}),
        buildPrompt: (symbol, data, peers) => ({
          system: 's',
          prompt: `analyze${peers ? '\nprior round\n' + peers : ''}`,
        }),
        bus,
        gunvest,
        provider,
      });
    }

    flipAgent('technical', 1.0, 2).start();
    flipAgent('news', 1.2, -2).start();
    flipAgent('social', 0.8, 2).start();
    flipAgent('contrarian', 0.9, -1).start();

    createEmitter({
      bus,
      repo,
      telegram: vi.fn(async () => {}),
      consensus,
      expectedAgents: 4,
    }).start();

    const orch = createOrchestrator({ bus, repo });
    await orch.kick('MU');

    await vi.waitFor(() => expect(sink.status).not.toBeNull());
    expect(sink.status).toBe('converged');
    expect(repo.addRound).toHaveBeenCalledTimes(2); // round 1 (split) + round 2 (converged)
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/e2e/consensus.test.js`
Expected: PASS (2 tests). A failure pinpoints which wiring is wrong (vote subject, constraint await, or iteration republish).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/consensus.test.js
git commit -m "test: add phase 2 multi-agent consensus e2e"
```

---

## Task 12: Process entrypoints, scheduler, scripts, compose, README

**Files:**

- Create: `legion/src/run/agent-news.js`, `legion/src/run/agent-social.js`, `legion/src/run/agent-contrarian.js`, `legion/src/run/risk.js`, `legion/src/run/scheduler.js`
- Modify: `legion/src/run/emitter.js` (default `expectedAgents`, `riskEnabled`)
- Modify: `legion/package.json` (scripts, `node-cron` dep)
- Modify: `legion/docker-compose.yml` (agent + risk + scheduler services)
- Modify: `legion/.env.example`, `legion/README.md`

Thin composition over already-tested modules; verified by the manual smoke test in Step 8.

- [ ] **Step 1: Add `node-cron` and run scripts to `package.json`**

In `dependencies` add (match GunVest's version if pinned there):

```json
    "node-cron": "^3.0.3"
```

In `scripts` add (keep existing entries):

```json
    "agent:news": "node src/run/agent-news.js",
    "agent:social": "node src/run/agent-social.js",
    "agent:contrarian": "node src/run/agent-contrarian.js",
    "risk": "node src/run/risk.js",
    "scheduler": "node src/run/scheduler.js"
```

Then install: `npm install`.

- [ ] **Step 2: Write the three agent entrypoints**

`src/run/agent-news.js`:

```js
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { createNewsAgent } from '../agents/news/index.js';
import { newsConfig } from '../agents/news/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestClient(cfg.gunvestApiUrl);
const provider = createProvider(newsConfig.provider, cfg);

createNewsAgent({ bus, gunvest, provider, config: newsConfig }).start();
console.log('[news] listening for cycles');
```

`src/run/agent-social.js`:

```js
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { createSocialAgent } from '../agents/social/index.js';
import { socialConfig } from '../agents/social/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestClient(cfg.gunvestApiUrl);
const provider = createProvider(socialConfig.provider, cfg);

createSocialAgent({ bus, gunvest, provider, config: socialConfig }).start();
console.log('[social] listening for cycles');
```

`src/run/agent-contrarian.js`:

```js
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { createContrarianAgent } from '../agents/contrarian/index.js';
import { contrarianConfig } from '../agents/contrarian/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestClient(cfg.gunvestApiUrl);
const provider = createProvider(contrarianConfig.provider, cfg);

createContrarianAgent({ bus, gunvest, provider, config: contrarianConfig }).start();
console.log('[contrarian] listening for cycles');
```

- [ ] **Step 3: Write `src/run/risk.js`**

```js
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createRiskManager } from '../risk/manager.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestClient(cfg.gunvestApiUrl);

createRiskManager({ bus, gunvest }).start();
console.log('[risk] listening for cycles');
```

- [ ] **Step 4: Update `src/run/emitter.js`**

Change the `expectedAgents` default to 4 and read `riskEnabled` from env. Replace the relevant lines:

```js
const expectedAgents = Number(process.env.LEGION_EXPECTED_AGENTS || '4');
const riskEnabled = process.env.LEGION_RISK_ENABLED !== 'false';

createEmitter({
  bus,
  repo,
  telegram,
  consensus: cfg.consensus,
  expectedAgents,
  riskEnabled,
}).start();
console.log(
  `[emitter] listening for votes (expectedAgents=${expectedAgents}, risk=${riskEnabled})`,
);
```

- [ ] **Step 5: Write `src/run/scheduler.js`**

```js
import 'dotenv/config';
import cron from 'node-cron';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createOrchestrator } from '../orchestrator.js';
import { createScheduler } from '../scheduler.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const repo = createRepo(connectDb(cfg.databaseUrl));
const orchestrator = createOrchestrator({ bus, repo });
const scheduler = createScheduler({ orchestrator, repo });

const schedule = process.env.LEGION_CRON || '0 */6 * * *'; // every 6h
cron.schedule(schedule, () => {
  scheduler.runOnce().then((s) => console.log(`[scheduler] kicked ${s.length} tickers`));
});
console.log(`[scheduler] armed (${schedule})`);

if (process.argv.includes('--now')) {
  const s = await scheduler.runOnce();
  console.log(`[scheduler] immediate run kicked ${s.length} tickers`);
}
```

- [ ] **Step 6: Add to `.env.example`**

```
# Emitter: voting agents to wait for, and whether the risk constraint is required
LEGION_EXPECTED_AGENTS=4
LEGION_RISK_ENABLED=true

# Scheduler cron (default every 6h)
LEGION_CRON=0 */6 * * *
```

- [ ] **Step 7: Add the Phase 2 services to `docker-compose.yml`**

Under `services`, add (alongside the Phase 0 `nats` and `ollama`). Each agent is its own container — the distributed, one-process-per-agent topology:

```yaml
emitter:
  build: .
  command: npm run emitter
  env_file: .env
  depends_on: [nats]
  restart: unless-stopped

agent-technical:
  build: .
  command: npm run agent:technical
  env_file: .env
  depends_on: [nats, ollama]
  restart: unless-stopped

agent-news:
  build: .
  command: npm run agent:news
  env_file: .env
  depends_on: [nats, ollama]
  restart: unless-stopped

agent-social:
  build: .
  command: npm run agent:social
  env_file: .env
  depends_on: [nats, ollama]
  restart: unless-stopped

agent-contrarian:
  build: .
  command: npm run agent:contrarian
  env_file: .env
  depends_on: [nats, ollama]
  restart: unless-stopped

risk:
  build: .
  command: npm run risk
  env_file: .env
  depends_on: [nats]
  restart: unless-stopped

scheduler:
  build: .
  command: npm run scheduler
  env_file: .env
  depends_on: [nats]
  restart: unless-stopped
```

> If `legion/Dockerfile` does not yet exist, add a minimal one: `FROM node:20-alpine`, `WORKDIR /app`, `COPY package*.json ./`, `RUN npm ci --omit=dev`, `COPY . .`, `CMD ["node", "--version"]` (the per-service `command` overrides `CMD`).

- [ ] **Step 8: Replace the Phase 1 run section in `README.md` with Phase 2**

````markdown
## Phase 2 — multi-agent consensus

Seed at least one enabled ticker:

```sql
INSERT INTO legion.tickers (symbol, enabled) VALUES ('NVDA', true)
ON CONFLICT (symbol) DO UPDATE SET enabled = true;
```

Run the gestalt (NATS + Ollama + GunVest + Postgres up). Each role is its own process:

```bash
npm run emitter            # waits for 4 votes + risk constraint per round
npm run agent:technical
npm run agent:news
npm run agent:social
npm run agent:contrarian
npm run risk
npm run scheduler -- --now # kicks all enabled tickers immediately
```

Or bring the whole topology up with Docker: `docker compose up -d`.

A consensus signal (or NO_CONSENSUS) lands in Telegram per ticker, and
`legion.rounds` holds every round of the debate for the dashboard.
````

- [ ] **Step 9: Manual smoke test**

With infra up, `.env` filled, and a ticker seeded:

```bash
npm run db:migrate
npm run emitter & npm run agent:technical & npm run agent:news & \
  npm run agent:social & npm run agent:contrarian & npm run risk &
npm run scheduler -- --now
```

Expected: each agent logs a published vote; the emitter logs round evaluation; a signal arrives in Telegram; `SELECT round_no, s_score, dispersion, quorum, converged FROM legion.rounds ORDER BY id;` shows one or more rounds; `SELECT band, conviction FROM legion.signals;` shows the final call.

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: all Phase 0 + Phase 1 + Phase 2 tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/run package.json docker-compose.yml Dockerfile .env.example README.md
git commit -m "feat: add phase 2 agent/risk/scheduler entrypoints and compose"
```

---

## Phase 2 Done — Handover Notes

Capture for the next session:

- Local-LLM JSON compliance across the four personas (abstain rate per agent) — if News/Social/Contrarian abstain often, tighten their prompts or add a one-shot retry in the factory.
- Convergence behavior on real data: how often round 1 converges vs. iterates to `R_max`; whether `θ_v = 0.5` is too strict/loose; tune in `config`.
- Risk constraint hit-rate (how often `capConviction`/`blockBuy` fired) and whether thresholds (`VIX_ELEVATED/EXTREME`, `OUTSIZED_MOVE_PCT`) match observed volatility.
- Per-cycle wall-clock on the A1 VM with 4 agents × up to 3 rounds serialized through one Ollama — confirms whether the 6h cadence holds or needs parallel model servers.
- Confirm GunVest exposes `getMacro().vix` and per-ticker `getSentiment`/`getNews` shapes the agents assume; adjust `gather` modules if the JSON differs.

**Next phase:** Phase 3 — dashboard (debate viewer reading `legion.rounds`/`legion.votes`, ticker config UI writing `legion.tickers`, signal feed). Write its own plan via the writing-plans skill.

---

## Self-Review

**Spec coverage (Phase 2 deliverable: add News, Social, Contrarian + Risk constraint; rounds/iteration/convergence; multi-ticker):**

- News/Catalyst agent (+macro) → Task 5 ✅
- Social Sentiment agent → Task 6 ✅
- Contrarian agent (+real crowd-positioning feeds: F&G/VIX reused from GunVest, CBOE/AAII/NAAIM/short-interest fetched legion-side with graceful null degradation; peer-dissent argument) → Task 7 ✅
- Risk Manager non-voting deterministic constraint, applied to magnitude/entry only → Task 8 ✅
- Multi-round iteration with forced dissent exposure (`priorVotes` → `summarizePeers` → prompt) → Tasks 3, 4, 9 ✅
- Convergence / `R_max` termination (`converged` vs `no_consensus`) → Task 9 ✅
- Every round persisted for the debate viewer → Task 9 (`addRound`/`addVote` each round) ✅
- Multi-ticker scheduling → Task 10 ✅
- Shared factory so new agents are drop-in (spec §4 "add-later modules") → Task 4 ✅
- Full gestalt proven end-to-end incl. iteration → Task 11 ✅
- Distributed one-process-per-agent topology → Task 12 compose ✅

**Type consistency:** Vote `{ agentId, stance, conviction, weight, rationale }` unchanged from Phase 0/1 across factory, parse, emitter, repo. Cycle/round-request `{ cycleId, symbol, round, priorVotes? }` — round 1 omits `priorVotes`, factory defaults to `[]` (so Phase 1 `orchestrator.test` `toEqual({cycleId,symbol,round})` stays green; orchestrator unchanged). Vote envelope `{ cycleId, symbol, round, vote }` consistent agent→emitter. Constraint `{ cycleId, symbol, round, constraint: { capConviction, blockBuy, reason } }` consistent manager→emitter→`applyRiskConstraint`. `evaluateRound` result `{ S, V, kappa, converged, band }` consumed identically in `buildSignal`, `repo.addRound`, and the emitter's `isFinal` check. `consensus` object gains `maxRounds` (already in Phase 0 `loadConfig`); `evaluateRound` ignores it, emitter uses it. Signal `{ symbol, band, conviction, plan }` preserved through `applyRiskConstraint` (adds `plan.riskReason/riskCapped/riskBlocked` only). `buildPrompt(symbol, data, peers)` signature uniform across all four agents; Phase 1 two-arg callers still valid (`peers` defaults `''`).

**Backward-compat with Phase 1 tests:** `technical/parse.js` re-exports shared parser (Phase 1 parse test green). `technical/prompt.js` two-arg calls still satisfy Phase 1 prompt test (`-2 to 2`, symbol, price present). `technical/index.js` still subscribes `cycleWildcard` via factory and publishes `voteSubject` (Phase 1 index + e2e green). Phase 1 `emit/emitter.test.js` is intentionally **replaced** in Task 9 Step 1 (single-`cycleId` keying superseded by per-round keying) — noted as a deliberate supersession, not a silent break.

**Placeholders:** none — every step contains full code. Two runtime assumptions (GunVest `vix`/sentiment/news shapes; local-LLM JSON compliance) are flagged for the Task 12 smoke test and handover; neither blocks the mock-tested tasks.
