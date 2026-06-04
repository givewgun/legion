# Legion Phase 1 — Single Agent End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the full Legion pipeline end-to-end with a single agent: an orchestrator kicks a ticker cycle over NATS → the **Technical agent** gathers data from GunVest, asks the local LLM for a structured vote → an **emitter** runs the (trivial N=1) consensus, persists it to Postgres, and pushes a signal to Telegram.

**Architecture:** Builds directly on the Phase 0 libraries (`bus`, `consensus`, `db`, `llm`, `data`, `config`). Three roles communicate only over the NATS bus: `orchestrator` (publishes `legion.cycle.*`), `technical` agent (subscribes cycles, publishes `legion.vote.*`), `emitter` (subscribes votes, evaluates, persists, notifies). An in-memory bus double lets the whole pipeline run in a single integration test with a stubbed LLM — no broker or DB required for tests.

**Tech Stack:** Same as Phase 0 (Node ESM, Vitest, `pg`, `nats`, native `fetch`). Telegram via raw Bot API `fetch` (no new dependency).

**Prerequisites:** Phase 0 complete (plan `2026-06-04-legion-phase0-foundation.md`). All Phase 0 modules exist and pass tests.

Spec: `gunvest/docs/superpowers/specs/2026-06-04-legion-design.md` (§3 consensus, §4 Technical agent, §6 module contract, §8 signal output).

---

## Phase 0 interfaces this plan depends on (do not redefine)

- `src/bus/subjects.js` → `cycleSubject(t)`, `voteSubject(t, r)`, `consensusSubject(t)`
- `src/bus/nats.js` → `createBus(connection)` → `{ publishJSON(subject, payload), subscribeJSON(subject, handler), close() }`
- `src/consensus/vote.js` → `createVote({...})`, `validateVote(vote)` → `{ ok, errors }`
- `src/consensus/aggregate.js` → `evaluateRound(votes, { thetaV, quorum, holdBand })` → `{ S, V, kappa, converged, band }`
- `src/consensus/stance.js` → `STANCE`, `isValidStance(n)`, `stanceBand(s, holdBand)`
- `src/db/client.js` → `createDb(pool)` → `{ query(text, params), queryOne(text, params), pool }`
- `src/llm/provider.js` → `createProvider(name, cfg, fetchImpl?)` → `{ name, generate({ system, prompt }) }`
- `src/data/gunvest.js` → `createGunvestClient(baseUrl, fetchImpl?)` → `{ getPrice, getNews, getSentiment, getMacro }`
- `src/config/index.js` → `loadConfig(env)` → `{ gunvestApiUrl, natsUrl, databaseUrl, ollama, consensus }`

**Message shapes introduced in this phase:**
- Cycle: `{ cycleId: number, symbol: string, round: number }`
- Vote envelope: `{ cycleId, symbol, round, vote: { agentId, stance, conviction, weight, rationale } }`
- Consensus: `{ cycleId, symbol, band, conviction, plan }`

---

## File Structure (Phase 1 additions)

```
legion/
  src/
    bus/
      subjects.js        # MODIFY: add cycleWildcard(), voteWildcard()
      memory.js          # NEW: in-process bus double (NATS-style wildcards)
    agents/
      technical/
        config.js        # id, weight, provider
        prompt.js        # buildPrompt(symbol, data) -> { system, prompt }
        gather.js        # gather(gunvest, symbol) -> data
        parse.js         # parseVote(text, { agentId, weight }) -> { ok, vote, errors }
        index.js         # createTechnicalAgent({ bus, gunvest, provider, config, holdBand })
    emit/
      plan.js            # buildSignal(evalResult, { symbol, votes }) -> { band, conviction, plan }
      telegram.js        # sendTelegram(token, chatId, text, fetchImpl?)
      emitter.js         # createEmitter({ bus, db, telegram, consensus, expectedAgents })
    db/
      repo.js            # createCycle/addRound/addVote/addSignal/finishCycle
    orchestrator.js      # createOrchestrator({ bus, db }) -> { kick(symbol) }
    run/
      agent-technical.js # process entrypoint
      emitter.js         # process entrypoint
      orchestrator.js    # process entrypoint (kick a ticker)
  test/
    bus/memory.test.js
    agents/technical/parse.test.js
    agents/technical/prompt.test.js
    agents/technical/gather.test.js
    agents/technical/index.test.js
    emit/plan.test.js
    emit/telegram.test.js
    emit/emitter.test.js
    db/repo.test.js
    orchestrator.test.js
    e2e/pipeline.test.js
```

---

## Task 1: Bus wildcards + in-memory bus double

**Files:**
- Modify: `legion/src/bus/subjects.js`
- Create: `legion/src/bus/memory.js`
- Test: `legion/test/bus/memory.test.js`

The in-memory bus implements the same `{ publishJSON, subscribeJSON, close }` interface as the real NATS bus, with NATS-style wildcard matching (`*` = one token, `>` = one-or-more trailing tokens). It dispatches synchronously so the e2e test can assert without timers.

- [ ] **Step 1: Add wildcard subject builders to `src/bus/subjects.js`**

Append these exports (keep existing ones unchanged):

```js
export function cycleWildcard() {
  return `${PREFIX}.cycle.*`;
}

export function voteWildcard() {
  return `${PREFIX}.vote.>`;
}
```

- [ ] **Step 2: Write the failing test `test/bus/memory.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';

describe('createMemoryBus', () => {
  it('delivers a published message to an exact-subject subscriber', () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribeJSON('legion.cycle.NVDA', handler);
    bus.publishJSON('legion.cycle.NVDA', { symbol: 'NVDA' });
    expect(handler).toHaveBeenCalledWith({ symbol: 'NVDA' });
  });

  it('matches a single-token * wildcard', () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribeJSON('legion.cycle.*', handler);
    bus.publishJSON('legion.cycle.MU', { symbol: 'MU' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not match * across multiple tokens', () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribeJSON('legion.cycle.*', handler);
    bus.publishJSON('legion.cycle.NVDA.1', { x: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('matches a trailing > wildcard across one or more tokens', () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribeJSON('legion.vote.>', handler);
    bus.publishJSON('legion.vote.NVDA.1', { stance: 1 });
    bus.publishJSON('legion.vote.MU.2', { stance: -1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('isolates non-matching subjects', () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribeJSON('legion.vote.>', handler);
    bus.publishJSON('legion.cycle.NVDA', { x: 1 });
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/bus/memory.test.js`
Expected: FAIL — `Cannot find module '../../src/bus/memory.js'`.

- [ ] **Step 4: Write `src/bus/memory.js`**

```js
// In-process bus double matching the createBus interface, with NATS-style
// wildcard subjects: '*' matches exactly one token, '>' matches one or more
// trailing tokens. Dispatch is synchronous (useful for deterministic tests).
function matches(pattern, subject) {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return s.length >= i + 1;
    if (i >= s.length) return false;
    if (p[i] === '*') continue;
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

export function createMemoryBus() {
  const subs = [];
  return {
    publishJSON(subject, payload) {
      for (const { pattern, handler } of subs) {
        if (matches(pattern, subject)) handler(payload);
      }
    },
    subscribeJSON(pattern, handler) {
      subs.push({ pattern, handler });
    },
    async close() {},
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/bus/memory.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/bus/subjects.js src/bus/memory.js test/bus/memory.test.js
git commit -m "feat: add bus wildcards and in-memory bus double"
```

---

## Task 2: Vote parsing from LLM output

**Files:**
- Create: `legion/src/agents/technical/parse.js`
- Test: `legion/test/agents/technical/parse.test.js`

The LLM is instructed to return JSON `{ stance, conviction, rationale }`. `parseVote` extracts the first JSON object (tolerating code fences / surrounding prose), maps it to a full vote with the agent's `agentId` and `weight`, and validates it.

- [ ] **Step 1: Write the failing test `test/agents/technical/parse.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { parseVote } from '../../../src/agents/technical/parse.js';

const ctx = { agentId: 'technical', weight: 1.0 };

describe('parseVote', () => {
  it('parses a clean JSON object', () => {
    const text = '{"stance": 1, "conviction": 0.8, "rationale": "uptrend"}';
    const res = parseVote(text, ctx);
    expect(res.ok).toBe(true);
    expect(res.vote).toEqual({
      agentId: 'technical',
      stance: 1,
      conviction: 0.8,
      weight: 1.0,
      rationale: 'uptrend',
    });
  });

  it('extracts JSON wrapped in code fences and prose', () => {
    const text = 'Here is my call:\n```json\n{"stance": -2, "conviction": 0.6, "rationale": "breakdown"}\n```\nThanks.';
    const res = parseVote(text, ctx);
    expect(res.ok).toBe(true);
    expect(res.vote.stance).toBe(-2);
    expect(res.vote.rationale).toBe('breakdown');
  });

  it('fails on unparseable text', () => {
    const res = parseVote('no json here', ctx);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('no JSON object found in LLM output');
  });

  it('fails validation on an out-of-range stance', () => {
    const res = parseVote('{"stance": 9, "conviction": 0.5, "rationale": "x"}', ctx);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('stance must be an integer in [-2,2]');
  });

  it('clamps missing rationale to empty string', () => {
    const res = parseVote('{"stance": 0, "conviction": 0.3}', ctx);
    expect(res.ok).toBe(true);
    expect(res.vote.rationale).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/technical/parse.test.js`
Expected: FAIL — `Cannot find module '.../parse.js'`.

- [ ] **Step 3: Write `src/agents/technical/parse.js`**

```js
import { createVote, validateVote } from '../../consensus/vote.js';

// Extracts the first balanced-looking JSON object from arbitrary LLM text.
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/technical/parse.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agents/technical/parse.js test/agents/technical/parse.test.js
git commit -m "feat: add LLM vote parser for technical agent"
```

---

## Task 3: Technical agent prompt builder

**Files:**
- Create: `legion/src/agents/technical/config.js`
- Create: `legion/src/agents/technical/prompt.js`
- Test: `legion/test/agents/technical/prompt.test.js`

- [ ] **Step 1: Write `src/agents/technical/config.js`**

```js
// Static config for the Technical agent. weight is the domain prior w_i;
// effective weight = w_i * rho_i (rho defaults to 1.0 until Phase 4).
export const technicalConfig = {
  id: 'technical',
  weight: 1.0,
  provider: 'local',
};
```

- [ ] **Step 2: Write the failing test `test/agents/technical/prompt.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../../src/agents/technical/prompt.js';

describe('buildPrompt', () => {
  it('produces a system persona and a data-bearing prompt', () => {
    const { system, prompt } = buildPrompt('NVDA', { price: 120, changePercent: 2.1 });
    expect(system).toMatch(/technical analyst/i);
    expect(prompt).toContain('NVDA');
    expect(prompt).toContain('120');
  });

  it('instructs the model to return strict JSON with the vote fields', () => {
    const { prompt } = buildPrompt('MU', { price: 90 });
    expect(prompt).toMatch(/"stance"/);
    expect(prompt).toMatch(/"conviction"/);
    expect(prompt).toMatch(/"rationale"/);
    expect(prompt).toMatch(/-2.*2/s); // documents the stance range
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/agents/technical/prompt.test.js`
Expected: FAIL — `Cannot find module '.../prompt.js'`.

- [ ] **Step 4: Write `src/agents/technical/prompt.js`**

```js
const SYSTEM = `You are a professional technical analyst on a multi-agent trading desk.
You judge a stock purely on price action, trend, momentum, and volatility.
You are decisive but honest about uncertainty.`;

// Builds the prompt. The model must answer with a single JSON object only.
export function buildPrompt(symbol, data) {
  const prompt = `Analyze ${symbol} from a technical standpoint.

Market data (JSON):
${JSON.stringify(data, null, 2)}

Respond with ONE JSON object and nothing else:
{
  "stance": <integer from -2 to 2: -2 STRONG_SELL, -1 SELL, 0 HOLD, 1 BUY, 2 STRONG_BUY>,
  "conviction": <number from 0 to 1>,
  "rationale": "<one or two sentences>"
}`;
  return { system: SYSTEM, prompt };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/agents/technical/prompt.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/agents/technical/config.js src/agents/technical/prompt.js test/agents/technical/prompt.test.js
git commit -m "feat: add technical agent config and prompt builder"
```

---

## Task 4: Technical agent data gathering

**Files:**
- Create: `legion/src/agents/technical/gather.js`
- Test: `legion/test/agents/technical/gather.test.js`

- [ ] **Step 1: Write the failing test `test/agents/technical/gather.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { gather } from '../../../src/agents/technical/gather.js';

describe('gather', () => {
  it('pulls price data from the GunVest client', async () => {
    const fakeClient = {
      getPrice: async (s) => ({ symbol: s, price: 120, changePercent: 1.5 }),
    };
    const data = await gather(fakeClient, 'NVDA');
    expect(data).toEqual({ symbol: 'NVDA', price: 120, changePercent: 1.5 });
  });

  it('uppercases the symbol when calling the client', async () => {
    let seen;
    const fakeClient = {
      getPrice: async (s) => {
        seen = s;
        return { price: 1 };
      },
    };
    await gather(fakeClient, 'mu');
    expect(seen).toBe('MU');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/technical/gather.test.js`
Expected: FAIL — `Cannot find module '.../gather.js'`.

- [ ] **Step 3: Write `src/agents/technical/gather.js`**

```js
// Pulls the inputs the Technical agent reasons over. Phase 1 uses price/market
// data; later phases can add indicators/history here without touching the runner.
export async function gather(gunvest, symbol) {
  return gunvest.getPrice(symbol.toUpperCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/technical/gather.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agents/technical/gather.js test/agents/technical/gather.test.js
git commit -m "feat: add technical agent data gathering"
```

---

## Task 5: Technical agent runner

**Files:**
- Create: `legion/src/agents/technical/index.js`
- Test: `legion/test/agents/technical/index.test.js`

Wires gather → prompt → provider → parse → publish. On a parse failure it abstains by publishing a HOLD vote with conviction 0 (the consensus math then treats it as no-signal weight), and logs the error — never crashes the pipeline.

- [ ] **Step 1: Write the failing test `test/agents/technical/index.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../../src/bus/memory.js';
import { createTechnicalAgent } from '../../../src/agents/technical/index.js';
import { cycleSubject, voteSubject } from '../../../src/bus/subjects.js';

function setup(generateImpl) {
  const bus = createMemoryBus();
  const gunvest = { getPrice: async (s) => ({ symbol: s, price: 100 }) };
  const provider = { name: 'local', generate: vi.fn(generateImpl) };
  const agent = createTechnicalAgent({
    bus,
    gunvest,
    provider,
    config: { id: 'technical', weight: 1.0 },
  });
  agent.start();
  return { bus, provider };
}

describe('createTechnicalAgent', () => {
  it('publishes a parsed vote in response to a cycle', async () => {
    const { bus } = setup(async () => '{"stance": 2, "conviction": 0.9, "rationale": "breakout"}');
    const votes = [];
    bus.subscribeJSON(voteSubject('NVDA', 1), (m) => votes.push(m));

    bus.publishJSON(cycleSubject('NVDA'), { cycleId: 7, symbol: 'NVDA', round: 1 });
    await vi.waitFor(() => expect(votes.length).toBe(1));

    expect(votes[0]).toMatchObject({
      cycleId: 7,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1.0, rationale: 'breakout' },
    });
  });

  it('abstains with a HOLD/0 vote when the LLM output is unparseable', async () => {
    const { bus } = setup(async () => 'I cannot decide.');
    const votes = [];
    bus.subscribeJSON(voteSubject('MU', 1), (m) => votes.push(m));

    bus.publishJSON(cycleSubject('MU'), { cycleId: 9, symbol: 'MU', round: 1 });
    await vi.waitFor(() => expect(votes.length).toBe(1));

    expect(votes[0].vote).toMatchObject({
      agentId: 'technical',
      stance: 0,
      conviction: 0,
      weight: 1.0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/technical/index.test.js`
Expected: FAIL — `Cannot find module '.../index.js'`.

- [ ] **Step 3: Write `src/agents/technical/index.js`**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/technical/index.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agents/technical/index.js test/agents/technical/index.test.js
git commit -m "feat: add technical agent runner with abstain fallback"
```

---

## Task 6: Signal / trade-plan builder

**Files:**
- Create: `legion/src/emit/plan.js`
- Test: `legion/test/emit/plan.test.js`

Turns an `evaluateRound` result + the contributing votes into an emittable signal. Phase 1 plan is intentionally minimal (band, conviction, per-agent rationale, horizon placeholder); Phase 2/5 enrich entry/stop/target/sizing.

- [ ] **Step 1: Write the failing test `test/emit/plan.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { buildSignal } from '../../src/emit/plan.js';

const votes = [
  { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
];

describe('buildSignal', () => {
  it('emits a converged signal with band and conviction', () => {
    const evalResult = { S: 1.8, V: 0.0, kappa: 1, converged: true, band: 'STRONG_BUY' };
    const sig = buildSignal(evalResult, { symbol: 'NVDA', votes });
    expect(sig.symbol).toBe('NVDA');
    expect(sig.band).toBe('STRONG_BUY');
    expect(sig.conviction).toBeCloseTo(0.9, 6); // |S|/2 capped at 1
    expect(sig.plan.rationales).toEqual([{ agentId: 'technical', rationale: 'breakout' }]);
  });

  it('emits NO_CONSENSUS when the round did not converge', () => {
    const evalResult = { S: 0.1, V: 4, kappa: 0.5, converged: false, band: 'HOLD' };
    const sig = buildSignal(evalResult, { symbol: 'MU', votes });
    expect(sig.band).toBe('NO_CONSENSUS');
    expect(sig.conviction).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/emit/plan.test.js`
Expected: FAIL — `Cannot find module '../../src/emit/plan.js'`.

- [ ] **Step 3: Write `src/emit/plan.js`**

```js
// Maps a round evaluation into an emittable signal. Conviction is |S|/2
// (the [-2,2] score normalized to [0,1]). Non-converged rounds emit NO_CONSENSUS.
export function buildSignal(evalResult, { symbol, votes }) {
  const rationales = votes.map((v) => ({ agentId: v.agentId, rationale: v.rationale }));
  if (!evalResult.converged) {
    return {
      symbol,
      band: 'NO_CONSENSUS',
      conviction: 0,
      plan: { horizon: 'unknown', rationales, dispersion: evalResult.V },
    };
  }
  return {
    symbol,
    band: evalResult.band,
    conviction: Math.min(Math.abs(evalResult.S) / 2, 1),
    plan: { horizon: 'swing', rationales, score: evalResult.S, quorum: evalResult.kappa },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/emit/plan.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/emit/plan.js test/emit/plan.test.js
git commit -m "feat: add signal/trade-plan builder"
```

---

## Task 7: Telegram client

**Files:**
- Create: `legion/src/emit/telegram.js`
- Test: `legion/test/emit/telegram.test.js`

Sends a message via the Telegram Bot API using `fetch` (injectable). Reuses GunVest's bot token + chat id from env.

- [ ] **Step 1: Write the failing test `test/emit/telegram.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { sendTelegram, formatSignal } from '../../src/emit/telegram.js';

describe('sendTelegram', () => {
  it('posts text to the bot sendMessage endpoint', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    await sendTelegram('TOKEN', '123', 'hello', fetchMock);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ chat_id: '123', text: 'hello', parse_mode: 'Markdown' });
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    await expect(sendTelegram('T', '1', 'x', fetchMock)).rejects.toThrow(
      'Telegram sendMessage failed: 401',
    );
  });
});

describe('formatSignal', () => {
  it('renders a readable signal message', () => {
    const text = formatSignal({
      symbol: 'NVDA',
      band: 'STRONG_BUY',
      conviction: 0.9,
      plan: { rationales: [{ agentId: 'technical', rationale: 'breakout' }] },
    });
    expect(text).toContain('NVDA');
    expect(text).toContain('STRONG_BUY');
    expect(text).toContain('90%');
    expect(text).toContain('technical');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/emit/telegram.test.js`
Expected: FAIL — `Cannot find module '../../src/emit/telegram.js'`.

- [ ] **Step 3: Write `src/emit/telegram.js`**

```js
export async function sendTelegram(token, chatId, text, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status}`);
  return res.json();
}

export function formatSignal(signal) {
  const pct = Math.round(signal.conviction * 100);
  const lines = [
    `*Legion signal: ${signal.symbol}*`,
    `Call: *${signal.band}*  (conviction ${pct}%)`,
    '',
    ...signal.plan.rationales.map((r) => `• _${r.agentId}_: ${r.rationale}`),
  ];
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/emit/telegram.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/emit/telegram.js test/emit/telegram.test.js
git commit -m "feat: add telegram client and signal formatter"
```

---

## Task 8: Database repository

**Files:**
- Create: `legion/src/db/repo.js`
- Test: `legion/test/db/repo.test.js`

Persistence helpers over the `legion` schema (Phase 0 tables). Tested with a fake pool that records SQL and returns canned `RETURNING` ids.

- [ ] **Step 1: Write the failing test `test/db/repo.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createRepo } from '../../src/db/repo.js';
import { createDb } from '../../src/db/client.js';

function poolReturning(idRows) {
  const calls = [];
  let i = 0;
  return {
    calls,
    query: vi.fn(async (text, params) => {
      calls.push({ text, params });
      const rows = idRows[i] ?? [];
      i += 1;
      return { rows };
    }),
  };
}

describe('createRepo', () => {
  it('creates a cycle and returns its id', async () => {
    const pool = poolReturning([[{ id: 42 }]]);
    const repo = createRepo(createDb(pool));
    const id = await repo.createCycle('NVDA');
    expect(id).toBe(42);
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.cycles/);
    expect(pool.calls[0].params).toEqual(['NVDA']);
  });

  it('adds a round and returns its id', async () => {
    const pool = poolReturning([[{ id: 5 }]]);
    const repo = createRepo(createDb(pool));
    const id = await repo.addRound(42, 1, { S: 1.8, V: 0, kappa: 1, converged: true });
    expect(id).toBe(5);
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.rounds/);
    expect(pool.calls[0].params).toEqual([42, 1, 1.8, 0, 1, true]);
  });

  it('adds a vote', async () => {
    const pool = poolReturning([[{ id: 1 }]]);
    const repo = createRepo(createDb(pool));
    await repo.addVote(5, {
      agentId: 'technical',
      stance: 2,
      conviction: 0.9,
      weight: 1,
      rationale: 'breakout',
    });
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.votes/);
    expect(pool.calls[0].params).toEqual([5, 'technical', 2, 0.9, 1, 'breakout']);
  });

  it('adds a signal with a JSONB plan', async () => {
    const pool = poolReturning([[{ id: 3 }]]);
    const repo = createRepo(createDb(pool));
    const id = await repo.addSignal(42, {
      symbol: 'NVDA',
      band: 'STRONG_BUY',
      conviction: 0.9,
      plan: { horizon: 'swing' },
    });
    expect(id).toBe(3);
    expect(pool.calls[0].params[0]).toBe(42);
    expect(pool.calls[0].params[1]).toBe('NVDA');
    expect(pool.calls[0].params[2]).toBe('STRONG_BUY');
    expect(pool.calls[0].params[4]).toBe(JSON.stringify({ horizon: 'swing' }));
  });

  it('finishes a cycle with a status', async () => {
    const pool = poolReturning([[]]);
    const repo = createRepo(createDb(pool));
    await repo.finishCycle(42, 'converged');
    expect(pool.calls[0].text).toMatch(/UPDATE legion\.cycles/);
    expect(pool.calls[0].params).toEqual(['converged', 42]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/repo.test.js`
Expected: FAIL — `Cannot find module '../../src/db/repo.js'`.

- [ ] **Step 3: Write `src/db/repo.js`**

```js
// Persistence over the legion schema. Each method maps to one INSERT/UPDATE.
export function createRepo(db) {
  return {
    async createCycle(symbol) {
      const row = await db.queryOne(
        `INSERT INTO legion.cycles (symbol) VALUES ($1) RETURNING id`,
        [symbol],
      );
      return row.id;
    },

    async addRound(cycleId, roundNo, { S, V, kappa, converged }) {
      const row = await db.queryOne(
        `INSERT INTO legion.rounds (cycle_id, round_no, s_score, dispersion, quorum, converged)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [cycleId, roundNo, S, V, kappa, converged],
      );
      return row.id;
    },

    async addVote(roundId, vote) {
      const row = await db.queryOne(
        `INSERT INTO legion.votes (round_id, agent_id, stance, conviction, weight, rationale)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [roundId, vote.agentId, vote.stance, vote.conviction, vote.weight, vote.rationale],
      );
      return row.id;
    },

    async addSignal(cycleId, signal) {
      const row = await db.queryOne(
        `INSERT INTO legion.signals (cycle_id, symbol, band, conviction, plan)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [cycleId, signal.symbol, signal.band, signal.conviction, JSON.stringify(signal.plan)],
      );
      return row.id;
    },

    async finishCycle(cycleId, status) {
      await db.query(
        `UPDATE legion.cycles SET status = $1, ended_at = now() WHERE id = $2`,
        [status, cycleId],
      );
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/repo.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/repo.js test/db/repo.test.js
git commit -m "feat: add legion db repository"
```

---

## Task 9: Emitter

**Files:**
- Create: `legion/src/emit/emitter.js`
- Test: `legion/test/emit/emitter.test.js`

Collects votes per cycle; once `expectedAgents` votes arrive, runs `evaluateRound`, persists round + votes + signal, finishes the cycle, sends Telegram, and publishes the consensus.

- [ ] **Step 1: Write the failing test `test/emit/emitter.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createEmitter } from '../../src/emit/emitter.js';
import { voteSubject, consensusSubject } from '../../src/bus/subjects.js';

function fakeRepo() {
  return {
    createCycle: vi.fn(async () => 1),
    addRound: vi.fn(async () => 10),
    addVote: vi.fn(async () => 100),
    addSignal: vi.fn(async () => 1000),
    finishCycle: vi.fn(async () => {}),
  };
}

describe('createEmitter', () => {
  it('evaluates after expected votes, persists, notifies, and publishes consensus', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const telegram = vi.fn(async () => {});
    const consensusMsgs = [];
    bus.subscribeJSON(consensusSubject('NVDA'), (m) => consensusMsgs.push(m));

    createEmitter({
      bus,
      repo,
      telegram,
      consensus: { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 },
      expectedAgents: 1,
    }).start();

    bus.publishJSON(voteSubject('NVDA', 1), {
      cycleId: 1,
      symbol: 'NVDA',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
    });

    await vi.waitFor(() => expect(telegram).toHaveBeenCalledTimes(1));
    expect(repo.addRound).toHaveBeenCalledTimes(1);
    expect(repo.addVote).toHaveBeenCalledTimes(1);
    expect(repo.addSignal).toHaveBeenCalledTimes(1);
    expect(repo.finishCycle).toHaveBeenCalledWith(1, 'converged');
    expect(consensusMsgs[0]).toMatchObject({ cycleId: 1, symbol: 'NVDA', band: 'STRONG_BUY' });
  });

  it('finishes as no_consensus when the round does not converge', async () => {
    const bus = createMemoryBus();
    const repo = fakeRepo();
    const telegram = vi.fn(async () => {});

    createEmitter({
      bus,
      repo,
      telegram,
      consensus: { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 },
      expectedAgents: 2,
    }).start();

    // two opposing strong votes → high dispersion, no convergence
    bus.publishJSON(voteSubject('MU', 1), {
      cycleId: 2,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'technical', stance: 2, conviction: 1, weight: 1, rationale: 'up' },
    });
    bus.publishJSON(voteSubject('MU', 1), {
      cycleId: 2,
      symbol: 'MU',
      round: 1,
      vote: { agentId: 'news', stance: -2, conviction: 1, weight: 1, rationale: 'down' },
    });

    await vi.waitFor(() => expect(repo.finishCycle).toHaveBeenCalledWith(2, 'no_consensus'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/emit/emitter.test.js`
Expected: FAIL — `Cannot find module '../../src/emit/emitter.js'`.

- [ ] **Step 3: Write `src/emit/emitter.js`**

```js
import { voteWildcard, consensusSubject } from '../bus/subjects.js';
import { evaluateRound } from '../consensus/aggregate.js';
import { buildSignal } from './plan.js';
import { formatSignal } from './telegram.js';

// Collects votes per cycle and finalizes once expectedAgents have voted.
export function createEmitter({ bus, repo, telegram, consensus, expectedAgents, logger = console }) {
  const pending = new Map(); // cycleId -> { symbol, round, votes: [] }

  async function finalize(cycleId, entry) {
    const votes = entry.votes;
    const result = evaluateRound(votes, consensus);
    const roundId = await repo.addRound(cycleId, entry.round, result);
    for (const v of votes) await repo.addVote(roundId, v);

    const signal = buildSignal(result, { symbol: entry.symbol, votes });
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
        if (!pending.has(cycleId)) pending.set(cycleId, { symbol, round, votes: [] });
        const entry = pending.get(cycleId);
        entry.votes.push(vote);
        if (entry.votes.length >= expectedAgents) {
          pending.delete(cycleId);
          finalize(cycleId, entry);
        }
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/emit/emitter.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/emit/emitter.js test/emit/emitter.test.js
git commit -m "feat: add emitter that finalizes cycles to db and telegram"
```

---

## Task 10: Orchestrator

**Files:**
- Create: `legion/src/orchestrator.js`
- Test: `legion/test/orchestrator.test.js`

Creates a cycle row, then publishes the cycle kick-off message. It is pure orchestration — it makes no consensus decision.

- [ ] **Step 1: Write the failing test `test/orchestrator.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../src/bus/memory.js';
import { createOrchestrator } from '../src/orchestrator.js';
import { cycleSubject } from '../src/bus/subjects.js';

describe('createOrchestrator', () => {
  it('creates a cycle and publishes the kick-off', async () => {
    const bus = createMemoryBus();
    const repo = { createCycle: vi.fn(async () => 77) };
    const msgs = [];
    bus.subscribeJSON(cycleSubject('NVDA'), (m) => msgs.push(m));

    const orch = createOrchestrator({ bus, repo });
    const cycleId = await orch.kick('NVDA');

    expect(cycleId).toBe(77);
    expect(repo.createCycle).toHaveBeenCalledWith('NVDA');
    expect(msgs[0]).toEqual({ cycleId: 77, symbol: 'NVDA', round: 1 });
  });

  it('uppercases the symbol', async () => {
    const bus = createMemoryBus();
    const repo = { createCycle: vi.fn(async () => 1) };
    const orch = createOrchestrator({ bus, repo });
    await orch.kick('mu');
    expect(repo.createCycle).toHaveBeenCalledWith('MU');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/orchestrator.test.js`
Expected: FAIL — `Cannot find module '../src/orchestrator.js'`.

- [ ] **Step 3: Write `src/orchestrator.js`**

```js
import { cycleSubject } from './bus/subjects.js';

// Kicks an evaluation cycle for a ticker. Round always starts at 1 in Phase 1.
export function createOrchestrator({ bus, repo }) {
  return {
    async kick(symbol) {
      const ticker = symbol.toUpperCase();
      const cycleId = await repo.createCycle(ticker);
      bus.publishJSON(cycleSubject(ticker), { cycleId, symbol: ticker, round: 1 });
      return cycleId;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/orchestrator.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.js test/orchestrator.test.js
git commit -m "feat: add orchestrator that kicks ticker cycles"
```

---

## Task 11: End-to-end pipeline integration test

**Files:**
- Test: `legion/test/e2e/pipeline.test.js`

Runs orchestrator → technical agent → emitter over the in-memory bus with a stubbed LLM and fake repo/telegram, asserting one signal flows through with the correct band.

- [ ] **Step 1: Write the test `test/e2e/pipeline.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createOrchestrator } from '../../src/orchestrator.js';
import { createTechnicalAgent } from '../../src/agents/technical/index.js';
import { createEmitter } from '../../src/emit/emitter.js';

describe('Legion Phase 1 pipeline', () => {
  it('flows a single ticker from kick to emitted signal', async () => {
    const bus = createMemoryBus();
    const telegram = vi.fn(async () => {});
    const signals = [];
    const repo = {
      createCycle: vi.fn(async () => 1),
      addRound: vi.fn(async () => 10),
      addVote: vi.fn(async () => 100),
      addSignal: vi.fn(async (cycleId, signal) => {
        signals.push(signal);
        return 1000;
      }),
      finishCycle: vi.fn(async () => {}),
    };
    const gunvest = { getPrice: async (s) => ({ symbol: s, price: 120, changePercent: 3 }) };
    const provider = {
      name: 'local',
      generate: async () => '{"stance": 2, "conviction": 0.85, "rationale": "strong uptrend"}',
    };

    createTechnicalAgent({
      bus,
      gunvest,
      provider,
      config: { id: 'technical', weight: 1.0 },
    }).start();

    createEmitter({
      bus,
      repo,
      telegram,
      consensus: { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 },
      expectedAgents: 1,
    }).start();

    const orch = createOrchestrator({ bus, repo });
    await orch.kick('NVDA');

    await vi.waitFor(() => expect(telegram).toHaveBeenCalledTimes(1));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ symbol: 'NVDA', band: 'STRONG_BUY' });
    expect(repo.finishCycle).toHaveBeenCalledWith(1, 'converged');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/e2e/pipeline.test.js`
Expected: PASS (1 test). If it fails, the failure pinpoints which wiring is wrong.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/pipeline.test.js
git commit -m "test: add phase 1 end-to-end pipeline integration test"
```

---

## Task 12: Process entrypoints + compose/README

**Files:**
- Create: `legion/src/run/agent-technical.js`
- Create: `legion/src/run/emitter.js`
- Create: `legion/src/run/orchestrator.js`
- Modify: `legion/package.json` (add run scripts)
- Modify: `legion/README.md` (Phase 1 run instructions)

These wire the real NATS connection, DB pool, GunVest client, and Ollama provider for live runs. No unit tests (thin composition over already-tested modules); verified by the manual smoke test in Step 6.

- [ ] **Step 1: Write `src/run/agent-technical.js`**

```js
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { createGunvestClient } from '../data/gunvest.js';
import { createProvider } from '../llm/provider.js';
import { createTechnicalAgent } from '../agents/technical/index.js';
import { technicalConfig } from '../agents/technical/config.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const gunvest = createGunvestClient(cfg.gunvestApiUrl);
const provider = createProvider(technicalConfig.provider, cfg);

createTechnicalAgent({ bus, gunvest, provider, config: technicalConfig }).start();
console.log('[technical] listening for cycles');
```

- [ ] **Step 2: Write `src/run/emitter.js`**

```js
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createEmitter } from '../emit/emitter.js';
import { sendTelegram } from '../emit/telegram.js';

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const repo = createRepo(connectDb(cfg.databaseUrl));

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const telegram = (text) => sendTelegram(token, chatId, text);

const expectedAgents = Number(process.env.LEGION_EXPECTED_AGENTS || '1');

createEmitter({ bus, repo, telegram, consensus: cfg.consensus, expectedAgents }).start();
console.log(`[emitter] listening for votes (expectedAgents=${expectedAgents})`);
```

- [ ] **Step 3: Write `src/run/orchestrator.js`**

```js
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectBus } from '../bus/nats.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createOrchestrator } from '../orchestrator.js';

const symbol = process.argv[2];
if (!symbol) {
  console.error('usage: node src/run/orchestrator.js <TICKER>');
  process.exit(1);
}

const cfg = loadConfig();
const bus = await connectBus(cfg.natsUrl);
const repo = createRepo(connectDb(cfg.databaseUrl));
const orch = createOrchestrator({ bus, repo });

const cycleId = await orch.kick(symbol);
console.log(`[orchestrator] kicked ${symbol.toUpperCase()} cycle ${cycleId}`);
setTimeout(() => process.exit(0), 500);
```

- [ ] **Step 4: Add run scripts to `package.json`**

Add to the `scripts` block (keep existing entries):

```json
    "agent:technical": "node src/run/agent-technical.js",
    "emitter": "node src/run/emitter.js",
    "kick": "node src/run/orchestrator.js"
```

Add these to `.env.example`:

```
# Telegram (reuse GunVest's bot)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Emitter: how many agent votes to wait for before evaluating
LEGION_EXPECTED_AGENTS=1
```

- [ ] **Step 5: Add a Phase 1 section to `README.md`**

````markdown
## Phase 1 — single agent end-to-end

Run each role in its own terminal (NATS + Ollama + GunVest must be up):

```bash
npm run emitter            # terminal 1: waits for votes
npm run agent:technical    # terminal 2: waits for cycles
npm run kick NVDA          # terminal 3: kicks one cycle
```

A signal should arrive in Telegram and a row should appear in `legion.signals`.
````

- [ ] **Step 6: Manual smoke test**

With NATS, Ollama (model pulled), GunVest, and Postgres running, and `.env` filled:
```bash
npm run db:migrate
npm run emitter &
npm run agent:technical &
npm run kick NVDA
```
Expected: console logs show the cycle kicked and a vote published; a Telegram message arrives; `SELECT * FROM legion.signals;` shows one row for NVDA.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all Phase 0 + Phase 1 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/run/agent-technical.js src/run/emitter.js src/run/orchestrator.js package.json .env.example README.md
git commit -m "feat: add phase 1 process entrypoints and run scripts"
```

---

## Phase 1 Done — Handover Notes

Capture for the next session:
- Actual GunVest price route shape vs. what `gather`/`getPrice` assumed; adjust `data/gunvest.js` if the JSON differs.
- Observed local-LLM JSON-compliance rate (how often `parseVote` had to abstain) — informs whether Phase 2 needs a stricter prompt or a retry.
- Measured single-cycle latency on the A1 VM.

**Next phase:** Phase 2 — add News/Catalyst, Social, Contrarian agents + Risk Manager constraint, multi-round iteration (dissent feedback, `R_max`), and multi-ticker scheduling. The emitter's `expectedAgents` + round loop generalize there. Write its own plan via the writing-plans skill.

---

## Self-Review

**Spec coverage (Phase 1 deliverable: Technical agent → vote → emitter → Telegram, 1 ticker):**
- Orchestrator kick over NATS → Task 10 ✅
- Technical agent (gather/prompt/reason/parse/publish) → Tasks 2,3,4,5 ✅
- Trivial N=1 consensus via `evaluateRound` → Task 9 (reuses Phase 0 Task 4) ✅
- Persistence to `legion` schema → Task 8 ✅
- Telegram signal → Task 7, wired in Task 9 ✅
- End-to-end proof → Task 11 ✅
- Runnable processes → Task 12 ✅

**Type consistency:** Vote shape `{ agentId, stance, conviction, weight, rationale }` matches Phase 0 across Tasks 2,5,8,9. Cycle message `{ cycleId, symbol, round }` consistent across orchestrator (Task 10), agent (Task 4), emitter (Task 9). Vote envelope `{ cycleId, symbol, round, vote }` consistent agent↔emitter. `evaluateRound` result `{ S, V, kappa, converged, band }` consumed identically in `buildSignal` (Task 6) and `repo.addRound` (Task 8). Signal shape `{ symbol, band, conviction, plan }` consistent across Tasks 6,7,8,9.

**Placeholders:** none — all steps contain full code. The two explicit assumptions (GunVest price route shape; LLM JSON compliance) are flagged for confirmation during the Task 12 smoke test and Phase 1 handover, and neither blocks the mock-tested tasks.
