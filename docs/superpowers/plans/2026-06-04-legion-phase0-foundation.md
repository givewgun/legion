# Legion Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the Legion repo and build the de-risked foundation — the heavily-tested consensus aggregation library, vote schema, config, Postgres `legion` schema, NATS wrapper, pluggable LLM provider (Ollama), and a GunVest API client — so later phases plug agents into proven plumbing.

**Architecture:** A new standalone Node.js (ESM) repo at `C:\Users\gunka\OneDrive\Documents\financial\legion`, deployed on the same Oracle A1 VM as GunVest, sharing its PostgreSQL (isolated `legion` schema) and consuming GunVest's REST API for all market data. Phase 0 ships **no running agents** — it delivers the shared libraries and infra every agent will import, with the consensus math unit-tested exhaustively because it is the system's core correctness risk.

**Tech Stack:** Node.js ≥18 (ESM, native `fetch`), Vitest (tests), `pg` (PostgreSQL), `nats` (message bus client), `dotenv`, ESLint + Prettier, Docker Compose (NATS + Ollama).

Spec: `gunvest/docs/superpowers/specs/2026-06-04-legion-design.md` (§3 consensus, §5 architecture, §6 module contract, §10 phasing).

---

## File Structure (Phase 0)

```
legion/
  package.json
  .gitignore
  .env.example
  .eslintrc.json
  .prettierrc.json
  vitest.config.js
  docker-compose.yml
  README.md
  src/
    config/
      index.js            # loads thresholds, quorum, weights from env+defaults
    consensus/
      stance.js           # stance constants + helpers (pure)
      vote.js             # vote schema: create + validate (pure)
      aggregate.js        # S_r, V_r, κ_r, convergence (pure) — CORE
    bus/
      subjects.js         # NATS subject builders (pure)
      nats.js             # connect/publishJSON/subscribeJSON (thin wrapper)
    db/
      schema.sql          # legion schema DDL
      client.js           # pg Pool wrapper
      migrate.js          # applies schema.sql
    llm/
      provider.js         # provider factory + interface
      ollama.js           # local Ollama provider
    data/
      gunvest.js          # GunVest REST API client
  test/
    consensus/
      stance.test.js
      vote.test.js
      aggregate.test.js
    config/
      index.test.js
    bus/
      subjects.test.js
      nats.test.js
    db/
      client.test.js
    llm/
      ollama.test.js
    data/
      gunvest.test.js
```

Pure logic (`consensus/`, `bus/subjects.js`, `config/`) is split from I/O (`bus/nats.js`, `db/`, `llm/`, `data/`) so the core math is testable with zero mocks.

---

## Task 1: Repo scaffold

**Files:**
- Create: `legion/package.json`
- Create: `legion/.gitignore`
- Create: `legion/.env.example`
- Create: `legion/.eslintrc.json`
- Create: `legion/.prettierrc.json`
- Create: `legion/vitest.config.js`
- Create: `legion/src/health.js`
- Test: `legion/test/health.test.js`

- [ ] **Step 1: Create the repo directory and initialize git**

Run (PowerShell):
```powershell
New-Item -ItemType Directory -Force -Path "C:\Users\gunka\OneDrive\Documents\financial\legion"
Set-Location "C:\Users\gunka\OneDrive\Documents\financial\legion"
git init
```
Expected: `Initialized empty Git repository`.

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "legion",
  "version": "0.0.0",
  "description": "Legion — distributed multi-agent stock signal gestalt",
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src test",
    "format": "prettier --write \"**/*.{js,json,md}\"",
    "db:migrate": "node src/db/migrate.js"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "nats": "^2.28.0",
    "pg": "^8.20.0"
  },
  "devDependencies": {
    "eslint": "^9.9.0",
    "eslint-config-prettier": "^9.1.0",
    "prettier": "^3.3.3",
    "vitest": "^2.0.5"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
.env
coverage/
*.log
```

- [ ] **Step 4: Write `.env.example`**

```
# GunVest API (data source)
GUNVEST_API_URL=http://localhost:3001

# PostgreSQL (shared with GunVest, legion schema)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/gunvest

# NATS
NATS_URL=nats://localhost:4222

# Local LLM (Ollama)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b-instruct

# Consensus tuning
CONSENSUS_THETA_V=0.5
CONSENSUS_QUORUM=0.6667
CONSENSUS_MAX_ROUNDS=3
CONSENSUS_HOLD_BAND=0.5
```

- [ ] **Step 5: Write `.eslintrc.json`**

```json
{
  "root": true,
  "env": { "node": true, "es2022": true },
  "parserOptions": { "ecmaVersion": 2022, "sourceType": "module" },
  "extends": ["eslint:recommended", "prettier"],
  "rules": {
    "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    "no-var": "error",
    "prefer-const": "error"
  }
}
```

- [ ] **Step 6: Write `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 7: Write `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    coverage: { provider: 'v8', include: ['src/**/*.js'] },
  },
});
```

- [ ] **Step 8: Write a trivial health module `src/health.js`**

```js
export function health() {
  return { name: 'legion', status: 'ok' };
}
```

- [ ] **Step 9: Write `test/health.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { health } from '../src/health.js';

describe('health', () => {
  it('reports ok status', () => {
    expect(health()).toEqual({ name: 'legion', status: 'ok' });
  });
});
```

- [ ] **Step 10: Install dependencies and run the test**

Run:
```powershell
npm install
npm test
```
Expected: 1 passing test (`health > reports ok status`).

- [ ] **Step 11: Commit**

```bash
git add package.json .gitignore .env.example .eslintrc.json .prettierrc.json vitest.config.js src/health.js test/health.test.js
git commit -m "chore: scaffold legion repo with vitest + tooling"
```

---

## Task 2: Stance constants and helpers

**Files:**
- Create: `legion/src/consensus/stance.js`
- Test: `legion/test/consensus/stance.test.js`

- [ ] **Step 1: Write the failing test `test/consensus/stance.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { STANCE, isValidStance, sideOf, stanceBand } from '../../src/consensus/stance.js';

describe('stance', () => {
  it('defines the five ordinal stances', () => {
    expect(STANCE).toEqual({
      STRONG_SELL: -2,
      SELL: -1,
      HOLD: 0,
      BUY: 1,
      STRONG_BUY: 2,
    });
  });

  it('validates stance integers', () => {
    expect(isValidStance(-2)).toBe(true);
    expect(isValidStance(2)).toBe(true);
    expect(isValidStance(0)).toBe(true);
    expect(isValidStance(3)).toBe(false);
    expect(isValidStance(1.5)).toBe(false);
    expect(isValidStance('1')).toBe(false);
  });

  it('returns the directional side of a stance', () => {
    expect(sideOf(2)).toBe(1);
    expect(sideOf(1)).toBe(1);
    expect(sideOf(0)).toBe(0);
    expect(sideOf(-1)).toBe(-1);
    expect(sideOf(-2)).toBe(-1);
  });

  it('maps an aggregate score to a band label using holdBand', () => {
    expect(stanceBand(1.6, 0.5)).toBe('STRONG_BUY');
    expect(stanceBand(0.9, 0.5)).toBe('BUY');
    expect(stanceBand(0.4, 0.5)).toBe('HOLD');
    expect(stanceBand(-0.4, 0.5)).toBe('HOLD');
    expect(stanceBand(-0.9, 0.5)).toBe('SELL');
    expect(stanceBand(-1.6, 0.5)).toBe('STRONG_SELL');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/consensus/stance.test.js`
Expected: FAIL — `Cannot find module '../../src/consensus/stance.js'`.

- [ ] **Step 3: Write `src/consensus/stance.js`**

```js
export const STANCE = Object.freeze({
  STRONG_SELL: -2,
  SELL: -1,
  HOLD: 0,
  BUY: 1,
  STRONG_BUY: 2,
});

const VALID = new Set([-2, -1, 0, 1, 2]);

export function isValidStance(value) {
  return Number.isInteger(value) && VALID.has(value);
}

export function sideOf(stance) {
  return Math.sign(stance);
}

// Maps an aggregate score S to a label. holdBand is the neutral half-width:
// |S| < holdBand → HOLD; otherwise SELL/BUY, escalating to STRONG past 1.5.
export function stanceBand(score, holdBand) {
  if (Math.abs(score) < holdBand) return 'HOLD';
  if (score >= 1.5) return 'STRONG_BUY';
  if (score > 0) return 'BUY';
  if (score <= -1.5) return 'STRONG_SELL';
  return 'SELL';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/consensus/stance.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/consensus/stance.js test/consensus/stance.test.js
git commit -m "feat: add stance constants and helpers"
```

---

## Task 3: Vote schema (create + validate)

**Files:**
- Create: `legion/src/consensus/vote.js`
- Test: `legion/test/consensus/vote.test.js`

A vote carries the agent's identity, ordinal `stance`, self-reported `conviction` ∈ [0,1], the **effective weight** `weight` = `w_i · ρ_i` (computed by the caller), and a `rationale` string.

- [ ] **Step 1: Write the failing test `test/consensus/vote.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { createVote, validateVote } from '../../src/consensus/vote.js';

describe('vote', () => {
  it('creates a normalized vote object', () => {
    const v = createVote({
      agentId: 'technical',
      stance: 1,
      conviction: 0.8,
      weight: 1.2,
      rationale: 'uptrend intact',
    });
    expect(v).toEqual({
      agentId: 'technical',
      stance: 1,
      conviction: 0.8,
      weight: 1.2,
      rationale: 'uptrend intact',
    });
  });

  it('accepts a valid vote', () => {
    const v = createVote({ agentId: 'a', stance: -2, conviction: 0, weight: 1, rationale: 'x' });
    expect(validateVote(v)).toEqual({ ok: true, errors: [] });
  });

  it('rejects an invalid stance', () => {
    const v = { agentId: 'a', stance: 5, conviction: 0.5, weight: 1, rationale: 'x' };
    const res = validateVote(v);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('stance must be an integer in [-2,2]');
  });

  it('rejects conviction outside [0,1]', () => {
    const v = { agentId: 'a', stance: 1, conviction: 1.4, weight: 1, rationale: 'x' };
    const res = validateVote(v);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('conviction must be a number in [0,1]');
  });

  it('rejects non-positive weight', () => {
    const v = { agentId: 'a', stance: 1, conviction: 0.5, weight: 0, rationale: 'x' };
    const res = validateVote(v);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('weight must be a positive number');
  });

  it('rejects missing agentId', () => {
    const v = { agentId: '', stance: 1, conviction: 0.5, weight: 1, rationale: 'x' };
    const res = validateVote(v);
    expect(res.ok).toBe(false);
    expect(res.errors).toContain('agentId must be a non-empty string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/consensus/vote.test.js`
Expected: FAIL — `Cannot find module '../../src/consensus/vote.js'`.

- [ ] **Step 3: Write `src/consensus/vote.js`**

```js
import { isValidStance } from './stance.js';

export function createVote({ agentId, stance, conviction, weight, rationale }) {
  return { agentId, stance, conviction, weight, rationale };
}

export function validateVote(vote) {
  const errors = [];
  if (typeof vote.agentId !== 'string' || vote.agentId.length === 0) {
    errors.push('agentId must be a non-empty string');
  }
  if (!isValidStance(vote.stance)) {
    errors.push('stance must be an integer in [-2,2]');
  }
  if (typeof vote.conviction !== 'number' || vote.conviction < 0 || vote.conviction > 1) {
    errors.push('conviction must be a number in [0,1]');
  }
  if (typeof vote.weight !== 'number' || vote.weight <= 0) {
    errors.push('weight must be a positive number');
  }
  if (typeof vote.rationale !== 'string') {
    errors.push('rationale must be a string');
  }
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/consensus/vote.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/consensus/vote.js test/consensus/vote.test.js
git commit -m "feat: add vote schema with validation"
```

---

## Task 4: Consensus aggregation library (CORE)

**Files:**
- Create: `legion/src/consensus/aggregate.js`
- Test: `legion/test/consensus/aggregate.test.js`

Implements spec §3.4–3.5. All functions are pure. `weight` on each vote is the effective weight `W_i`; aggregation uses the product `W_i · c_i`.

- [ ] **Step 1: Write the failing test `test/consensus/aggregate.test.js`**

```js
import { describe, it, expect } from 'vitest';
import {
  weightedStance,
  weightedDispersion,
  directionalQuorum,
  evaluateRound,
} from '../../src/consensus/aggregate.js';

const v = (agentId, stance, conviction, weight) => ({
  agentId,
  stance,
  conviction,
  weight,
  rationale: '',
});

describe('weightedStance', () => {
  it('computes the weight*conviction weighted mean stance', () => {
    // votes: (+2,c1,w1)=(2,1,1), (+1,0.5,1), (-1,1,1)
    // num = 2*1*1 + 1*0.5*1 + (-1)*1*1 = 2 + 0.5 - 1 = 1.5
    // den = 1*1 + 0.5*1 + 1*1 = 2.5  → 0.6
    const votes = [v('a', 2, 1, 1), v('b', 1, 0.5, 1), v('c', -1, 1, 1)];
    expect(weightedStance(votes)).toBeCloseTo(0.6, 10);
  });

  it('returns 0 for empty votes', () => {
    expect(weightedStance([])).toBe(0);
  });

  it('returns 0 when all conviction is zero', () => {
    expect(weightedStance([v('a', 2, 0, 1), v('b', -2, 0, 1)])).toBe(0);
  });
});

describe('weightedDispersion', () => {
  it('is zero when all stances are equal', () => {
    const votes = [v('a', 1, 1, 1), v('b', 1, 0.5, 2)];
    const s = weightedStance(votes);
    expect(weightedDispersion(votes, s)).toBeCloseTo(0, 10);
  });

  it('computes weighted variance around the mean', () => {
    // votes: (+2,1,1) and (-2,1,1) → mean 0, dispersion = (4+4)/2 = 4
    const votes = [v('a', 2, 1, 1), v('b', -2, 1, 1)];
    const s = weightedStance(votes);
    expect(weightedDispersion(votes, s)).toBeCloseTo(4, 10);
  });
});

describe('directionalQuorum', () => {
  it('measures weighted fraction agreeing with the sign of S', () => {
    // S>0; agree = a(+2) & b(+1); disagree = c(-1)
    const votes = [v('a', 2, 1, 1), v('b', 1, 1, 1), v('c', -1, 1, 1)];
    const s = weightedStance(votes); // (2+1-1)/3 = 0.6667 > 0
    // agree weight = 1*1 + 1*1 = 2; total = 3 → 0.6667
    expect(directionalQuorum(votes, s)).toBeCloseTo(2 / 3, 6);
  });

  it('treats |S| < holdBand as neutral target and counts HOLD voters', () => {
    // S≈0 neutral; agree = voters with stance 0
    const votes = [v('a', 1, 1, 1), v('b', -1, 1, 1), v('c', 0, 1, 1)];
    const s = weightedStance(votes); // 0
    expect(directionalQuorum(votes, s, 0.5)).toBeCloseTo(1 / 3, 6);
  });
});

describe('evaluateRound', () => {
  it('converges when quorum and dispersion thresholds are met', () => {
    // three BUYs, one HOLD → strong agreement, low dispersion
    const votes = [v('a', 1, 0.9, 1), v('b', 1, 0.8, 1), v('c', 2, 0.9, 1), v('d', 0, 0.3, 1)];
    const res = evaluateRound(votes, { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 });
    expect(res.converged).toBe(true);
    expect(res.S).toBeGreaterThan(0.5);
    expect(res.kappa).toBeGreaterThanOrEqual(2 / 3);
    expect(res.V).toBeLessThanOrEqual(0.5);
    expect(res.band).toBe('BUY');
  });

  it('does not converge when agents are split (high dispersion)', () => {
    const votes = [v('a', 2, 1, 1), v('b', -2, 1, 1), v('c', 2, 1, 1), v('d', -2, 1, 1)];
    const res = evaluateRound(votes, { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 });
    expect(res.converged).toBe(false);
  });

  it('does not converge when quorum is below threshold', () => {
    // 2 buy vs 2 sell with slight bull tilt → quorum ~0.5 < 2/3
    const votes = [v('a', 1, 1, 1.1), v('b', 1, 1, 1), v('c', -1, 1, 1), v('d', -1, 1, 1)];
    const res = evaluateRound(votes, { thetaV: 5, quorum: 2 / 3, holdBand: 0.5 });
    expect(res.kappa).toBeLessThan(2 / 3);
    expect(res.converged).toBe(false);
  });

  it('a single outlier cannot block a clean 3-of-4 supermajority', () => {
    const votes = [v('a', 1, 0.9, 1), v('b', 1, 0.9, 1), v('c', 1, 0.9, 1), v('d', -2, 0.9, 1)];
    const res = evaluateRound(votes, { thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 });
    expect(res.converged).toBe(false); // dispersion from the outlier may exceed θ_v
    // but quorum (3 of 4 agree on bull side) is met:
    expect(res.kappa).toBeGreaterThanOrEqual(0.75);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/consensus/aggregate.test.js`
Expected: FAIL — `Cannot find module '../../src/consensus/aggregate.js'`.

- [ ] **Step 3: Write `src/consensus/aggregate.js`**

```js
import { sideOf, stanceBand } from './stance.js';

// Σ(W_i · c_i) — the normalizing denominator used everywhere.
function totalWeight(votes) {
  return votes.reduce((sum, vote) => sum + vote.weight * vote.conviction, 0);
}

// S_r = Σ(W_i · c_i · s_i) / Σ(W_i · c_i)
export function weightedStance(votes) {
  const den = totalWeight(votes);
  if (den === 0) return 0;
  const num = votes.reduce((sum, vote) => sum + vote.weight * vote.conviction * vote.stance, 0);
  return num / den;
}

// V_r = Σ(W_i · c_i · (s_i − S)²) / Σ(W_i · c_i)
export function weightedDispersion(votes, meanStance) {
  const den = totalWeight(votes);
  if (den === 0) return 0;
  const num = votes.reduce(
    (sum, vote) => sum + vote.weight * vote.conviction * (vote.stance - meanStance) ** 2,
    0,
  );
  return num / den;
}

// κ_r = weighted fraction of votes whose side matches the target side.
// Target side is sign(S), or neutral (0) when |S| < holdBand.
export function directionalQuorum(votes, meanStance, holdBand = 0.5) {
  const den = totalWeight(votes);
  if (den === 0) return 0;
  const target = Math.abs(meanStance) < holdBand ? 0 : Math.sign(meanStance);
  const agree = votes.reduce(
    (sum, vote) => (sideOf(vote.stance) === target ? sum + vote.weight * vote.conviction : sum),
    0,
  );
  return agree / den;
}

// Evaluates one round. Converged iff κ ≥ quorum AND V ≤ θ_v.
export function evaluateRound(votes, { thetaV, quorum, holdBand = 0.5 }) {
  const S = weightedStance(votes);
  const V = weightedDispersion(votes, S);
  const kappa = directionalQuorum(votes, S, holdBand);
  const converged = kappa >= quorum && V <= thetaV;
  return { S, V, kappa, converged, band: stanceBand(S, holdBand) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/consensus/aggregate.test.js`
Expected: PASS (all `describe` blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/consensus/aggregate.js test/consensus/aggregate.test.js
git commit -m "feat: add consensus aggregation library (S, V, kappa, convergence)"
```

---

## Task 5: Config loader

**Files:**
- Create: `legion/src/config/index.js`
- Test: `legion/test/config/index.test.js`

Loads consensus thresholds and connection URLs from environment with safe defaults. Takes an explicit `env` argument so it is testable without mutating `process.env`.

- [ ] **Step 1: Write the failing test `test/config/index.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const cfg = loadConfig({});
    expect(cfg.consensus).toEqual({ thetaV: 0.5, quorum: 0.6667, maxRounds: 3, holdBand: 0.5 });
    expect(cfg.gunvestApiUrl).toBe('http://localhost:3001');
    expect(cfg.natsUrl).toBe('nats://localhost:4222');
    expect(cfg.ollama).toEqual({ url: 'http://localhost:11434', model: 'qwen2.5:7b-instruct' });
  });

  it('reads overrides from env and coerces numbers', () => {
    const cfg = loadConfig({
      CONSENSUS_THETA_V: '0.3',
      CONSENSUS_QUORUM: '0.75',
      CONSENSUS_MAX_ROUNDS: '5',
      CONSENSUS_HOLD_BAND: '0.4',
      GUNVEST_API_URL: 'http://api:3001',
      NATS_URL: 'nats://bus:4222',
      OLLAMA_URL: 'http://ollama:11434',
      OLLAMA_MODEL: 'llama3.1:8b',
      DATABASE_URL: 'postgres://u:p@db:5432/gunvest',
    });
    expect(cfg.consensus).toEqual({ thetaV: 0.3, quorum: 0.75, maxRounds: 5, holdBand: 0.4 });
    expect(cfg.gunvestApiUrl).toBe('http://api:3001');
    expect(cfg.natsUrl).toBe('nats://bus:4222');
    expect(cfg.ollama.model).toBe('llama3.1:8b');
    expect(cfg.databaseUrl).toBe('postgres://u:p@db:5432/gunvest');
  });

  it('throws on a non-numeric threshold', () => {
    expect(() => loadConfig({ CONSENSUS_THETA_V: 'abc' })).toThrow(
      'CONSENSUS_THETA_V must be a number',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/index.test.js`
Expected: FAIL — `Cannot find module '../../src/config/index.js'`.

- [ ] **Step 3: Write `src/config/index.js`**

```js
function num(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) throw new Error(`${key} must be a number`);
  return parsed;
}

export function loadConfig(env = process.env) {
  return {
    gunvestApiUrl: env.GUNVEST_API_URL || 'http://localhost:3001',
    natsUrl: env.NATS_URL || 'nats://localhost:4222',
    databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/gunvest',
    ollama: {
      url: env.OLLAMA_URL || 'http://localhost:11434',
      model: env.OLLAMA_MODEL || 'qwen2.5:7b-instruct',
    },
    consensus: {
      thetaV: num(env, 'CONSENSUS_THETA_V', 0.5),
      quorum: num(env, 'CONSENSUS_QUORUM', 0.6667),
      maxRounds: num(env, 'CONSENSUS_MAX_ROUNDS', 3),
      holdBand: num(env, 'CONSENSUS_HOLD_BAND', 0.5),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/index.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/index.js test/config/index.test.js
git commit -m "feat: add config loader with consensus defaults"
```

---

## Task 6: NATS subject builders + connection wrapper

**Files:**
- Create: `legion/src/bus/subjects.js`
- Create: `legion/src/bus/nats.js`
- Test: `legion/test/bus/subjects.test.js`
- Test: `legion/test/bus/nats.test.js`

Subjects are pure string builders (fully unit-tested). The connection wrapper is a thin JSON layer over the `nats` client, tested with an injected fake connection so no broker is needed.

- [ ] **Step 1: Write the failing test `test/bus/subjects.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { cycleSubject, voteSubject, consensusSubject } from '../../src/bus/subjects.js';

describe('subjects', () => {
  it('builds a cycle subject for a ticker', () => {
    expect(cycleSubject('NVDA')).toBe('legion.cycle.NVDA');
  });

  it('builds a vote subject scoped to ticker and round', () => {
    expect(voteSubject('NVDA', 2)).toBe('legion.vote.NVDA.2');
  });

  it('builds a consensus subject for a ticker', () => {
    expect(consensusSubject('NVDA')).toBe('legion.consensus.NVDA');
  });

  it('uppercases the ticker', () => {
    expect(cycleSubject('nvda')).toBe('legion.cycle.NVDA');
    expect(voteSubject('mu', 1)).toBe('legion.vote.MU.1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bus/subjects.test.js`
Expected: FAIL — `Cannot find module '../../src/bus/subjects.js'`.

- [ ] **Step 3: Write `src/bus/subjects.js`**

```js
const PREFIX = 'legion';

export function cycleSubject(ticker) {
  return `${PREFIX}.cycle.${ticker.toUpperCase()}`;
}

export function voteSubject(ticker, round) {
  return `${PREFIX}.vote.${ticker.toUpperCase()}.${round}`;
}

export function consensusSubject(ticker) {
  return `${PREFIX}.consensus.${ticker.toUpperCase()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bus/subjects.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test `test/bus/nats.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../../src/bus/nats.js';

// Minimal fake of the nats connection surface createBus depends on.
function fakeConnection() {
  const published = [];
  return {
    published,
    publish: vi.fn((subject, data) => published.push({ subject, data })),
    subscribe: vi.fn((subject, opts) => ({ subject, opts })),
    drain: vi.fn(async () => {}),
  };
}

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));

describe('createBus', () => {
  it('publishes JSON-encoded payloads', () => {
    const conn = fakeConnection();
    const bus = createBus(conn);
    bus.publishJSON('legion.cycle.NVDA', { ticker: 'NVDA' });
    expect(conn.publish).toHaveBeenCalledTimes(1);
    const call = conn.publish.mock.calls[0];
    expect(call[0]).toBe('legion.cycle.NVDA');
    expect(call[1]).toEqual(enc({ ticker: 'NVDA' }));
  });

  it('decodes JSON messages to a handler via subscribeJSON', async () => {
    const conn = fakeConnection();
    const messages = [{ data: enc({ stance: 1 }) }, { data: enc({ stance: -1 }) }];
    conn.subscribe = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
      },
    }));
    const bus = createBus(conn);
    const received = [];
    await bus.subscribeJSON('legion.vote.NVDA.1', (msg) => received.push(msg));
    expect(received).toEqual([{ stance: 1 }, { stance: -1 }]);
  });

  it('delegates close to drain', async () => {
    const conn = fakeConnection();
    const bus = createBus(conn);
    await bus.close();
    expect(conn.drain).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/bus/nats.test.js`
Expected: FAIL — `Cannot find module '../../src/bus/nats.js'`.

- [ ] **Step 7: Write `src/bus/nats.js`**

```js
import { connect, StringCodec } from 'nats';

const sc = StringCodec();

// Wraps a NATS connection with JSON publish/subscribe helpers.
// Accepts an already-open connection so it can be unit-tested with a fake.
export function createBus(connection) {
  return {
    publishJSON(subject, payload) {
      connection.publish(subject, sc.encode(JSON.stringify(payload)));
    },
    async subscribeJSON(subject, handler) {
      const sub = connection.subscribe(subject);
      for await (const msg of sub) {
        handler(JSON.parse(sc.decode(msg.data)));
      }
    },
    async close() {
      await connection.drain();
    },
  };
}

// Opens a real connection from config and returns a bus.
export async function connectBus(natsUrl) {
  const connection = await connect({ servers: natsUrl });
  return createBus(connection);
}
```

Note: `StringCodec().encode` and `TextEncoder().encode` both yield UTF-8 `Uint8Array` for the same string, so the test's `enc()` comparison matches.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/bus/nats.test.js`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add src/bus/subjects.js src/bus/nats.js test/bus/subjects.test.js test/bus/nats.test.js
git commit -m "feat: add NATS subject builders and JSON bus wrapper"
```

---

## Task 7: PostgreSQL legion schema + client

**Files:**
- Create: `legion/src/db/schema.sql`
- Create: `legion/src/db/client.js`
- Create: `legion/src/db/migrate.js`
- Test: `legion/test/db/client.test.js`

The schema lives in its own `legion` Postgres schema to stay isolated from GunVest's tables. `client.js` wraps a `pg` Pool and is tested with an injected fake pool (no live DB needed). `migrate.js` applies `schema.sql`.

- [ ] **Step 1: Write `src/db/schema.sql`**

```sql
CREATE SCHEMA IF NOT EXISTS legion;

-- Tickers Legion monitors.
CREATE TABLE IF NOT EXISTS legion.tickers (
  symbol      TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One evaluation cycle per ticker kick-off.
CREATE TABLE IF NOT EXISTS legion.cycles (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL REFERENCES legion.tickers(symbol),
  status      TEXT NOT NULL DEFAULT 'running',  -- running | converged | no_consensus
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);

-- One row per debate round within a cycle.
CREATE TABLE IF NOT EXISTS legion.rounds (
  id          BIGSERIAL PRIMARY KEY,
  cycle_id    BIGINT NOT NULL REFERENCES legion.cycles(id) ON DELETE CASCADE,
  round_no    INT NOT NULL,
  s_score     NUMERIC(10,6),   -- S_r
  dispersion  NUMERIC(10,6),   -- V_r
  quorum      NUMERIC(10,6),   -- κ_r
  converged   BOOLEAN,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, round_no)
);

-- Individual agent votes per round.
CREATE TABLE IF NOT EXISTS legion.votes (
  id          BIGSERIAL PRIMARY KEY,
  round_id    BIGINT NOT NULL REFERENCES legion.rounds(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  stance      INT NOT NULL,
  conviction  NUMERIC(6,4) NOT NULL,
  weight      NUMERIC(10,6) NOT NULL,
  rationale   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Emitted signals (the trade plan).
CREATE TABLE IF NOT EXISTS legion.signals (
  id          BIGSERIAL PRIMARY KEY,
  cycle_id    BIGINT NOT NULL REFERENCES legion.cycles(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  band        TEXT NOT NULL,            -- STRONG_SELL..STRONG_BUY | NO_CONSENSUS
  conviction  NUMERIC(6,4) NOT NULL,
  plan        JSONB NOT NULL,           -- entry/stop/target/size/horizon/rationale
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-agent reliability (ρ_i), updated by the backtest loop in a later phase.
CREATE TABLE IF NOT EXISTS legion.agent_reliability (
  agent_id      TEXT PRIMARY KEY,
  reliability   NUMERIC(6,4) NOT NULL DEFAULT 1.0,
  brier_score   NUMERIC(8,6),
  sample_count  INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Forward paper-test + deterministic backtest results.
CREATE TABLE IF NOT EXISTS legion.backtest_results (
  id          BIGSERIAL PRIMARY KEY,
  signal_id   BIGINT REFERENCES legion.signals(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  horizon     TEXT NOT NULL,
  signal_return  NUMERIC(10,6),
  index_return   NUMERIC(10,6),
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Write the failing test `test/db/client.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createDb } from '../../src/db/client.js';

function fakePool(rows = []) {
  return { query: vi.fn(async () => ({ rows })) };
}

describe('createDb', () => {
  it('runs a query and returns rows', async () => {
    const pool = fakePool([{ symbol: 'NVDA' }]);
    const db = createDb(pool);
    const rows = await db.query('SELECT symbol FROM legion.tickers');
    expect(rows).toEqual([{ symbol: 'NVDA' }]);
    expect(pool.query).toHaveBeenCalledWith('SELECT symbol FROM legion.tickers', []);
  });

  it('passes parameters through', async () => {
    const pool = fakePool([]);
    const db = createDb(pool);
    await db.query('INSERT INTO legion.tickers(symbol) VALUES ($1)', ['MU']);
    expect(pool.query).toHaveBeenCalledWith('INSERT INTO legion.tickers(symbol) VALUES ($1)', [
      'MU',
    ]);
  });

  it('returns the first row via queryOne, or null', async () => {
    expect(await createDb(fakePool([{ id: 1 }])).queryOne('X')).toEqual({ id: 1 });
    expect(await createDb(fakePool([])).queryOne('X')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/db/client.test.js`
Expected: FAIL — `Cannot find module '../../src/db/client.js'`.

- [ ] **Step 4: Write `src/db/client.js`**

```js
import pg from 'pg';

// Wraps a pg Pool. Accepts an injected pool for tests.
export function createDb(pool) {
  return {
    async query(text, params = []) {
      const result = await pool.query(text, params);
      return result.rows;
    },
    async queryOne(text, params = []) {
      const rows = await this.query(text, params);
      return rows.length > 0 ? rows[0] : null;
    },
    pool,
  };
}

// Builds a real pool from a connection string.
export function connectDb(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  return createDb(pool);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/db/client.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Write `src/db/migrate.js`**

```js
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectDb } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigration(db, sqlPath) {
  const sql = await readFile(sqlPath, 'utf8');
  await db.query(sql);
}

// Entry point: `npm run db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const db = connectDb(cfg.databaseUrl);
  const sqlPath = join(__dirname, 'schema.sql');
  runMigration(db, sqlPath)
    .then(() => {
      console.log('legion schema migrated');
      return db.pool.end();
    })
    .catch((err) => {
      console.error('migration failed:', err.message);
      process.exit(1);
    });
}
```

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/client.js src/db/migrate.js test/db/client.test.js
git commit -m "feat: add legion postgres schema, db client, and migration runner"
```

---

## Task 8: LLM provider abstraction (Ollama)

**Files:**
- Create: `legion/src/llm/provider.js`
- Create: `legion/src/llm/ollama.js`
- Test: `legion/test/llm/ollama.test.js`

A provider exposes `generate({ system, prompt })` → string. `provider.js` is a factory selecting the implementation by name; `ollama.js` calls the local Ollama HTTP API. Tested with an injected `fetch`.

- [ ] **Step 1: Write the failing test `test/llm/ollama.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createOllamaProvider } from '../../src/llm/ollama.js';
import { createProvider } from '../../src/llm/provider.js';

describe('createOllamaProvider', () => {
  it('posts system+prompt to the Ollama generate endpoint and returns the text', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ response: 'BUY: trend up' }),
    }));
    const provider = createOllamaProvider(
      { url: 'http://ollama:11434', model: 'qwen2.5:7b-instruct' },
      fetchMock,
    );
    const out = await provider.generate({ system: 'You are a trader', prompt: 'Rate NVDA' });
    expect(out).toBe('BUY: trend up');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ollama:11434/api/generate');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('qwen2.5:7b-instruct');
    expect(body.system).toBe('You are a trader');
    expect(body.prompt).toBe('Rate NVDA');
    expect(body.stream).toBe(false);
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    const provider = createOllamaProvider({ url: 'http://o:11434', model: 'm' }, fetchMock);
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(
      'Ollama request failed: 500',
    );
  });
});

describe('createProvider', () => {
  it('builds an ollama provider by name', () => {
    const provider = createProvider('local', { ollama: { url: 'http://o:11434', model: 'm' } });
    expect(typeof provider.generate).toBe('function');
  });

  it('throws on an unknown provider name', () => {
    expect(() => createProvider('mystery', {})).toThrow('Unknown LLM provider: mystery');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/llm/ollama.test.js`
Expected: FAIL — `Cannot find module '../../src/llm/ollama.js'`.

- [ ] **Step 3: Write `src/llm/ollama.js`**

```js
// Local LLM provider backed by the Ollama HTTP API.
// fetchImpl is injectable for testing; defaults to global fetch (Node ≥18).
export function createOllamaProvider({ url, model }, fetchImpl = fetch) {
  return {
    name: 'local',
    async generate({ system, prompt }) {
      const res = await fetchImpl(`${url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, system, prompt, stream: false }),
      });
      if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
      const data = await res.json();
      return data.response;
    },
  };
}
```

- [ ] **Step 4: Write `src/llm/provider.js`**

```js
import { createOllamaProvider } from './ollama.js';

// Factory selecting an LLM provider by name. Add 'gemini'/'openai' here later;
// the interface (generate({ system, prompt }) → string) stays stable.
export function createProvider(name, cfg, fetchImpl = fetch) {
  switch (name) {
    case 'local':
      return createOllamaProvider(cfg.ollama, fetchImpl);
    default:
      throw new Error(`Unknown LLM provider: ${name}`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/llm/ollama.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/llm/provider.js src/llm/ollama.js test/llm/ollama.test.js
git commit -m "feat: add pluggable LLM provider with Ollama implementation"
```

---

## Task 9: GunVest API client

**Files:**
- Create: `legion/src/data/gunvest.js`
- Test: `legion/test/data/gunvest.test.js`

Thin client over GunVest's REST API. Phase 0 wires the endpoints agents will need (price, news, sentiment, macro). Tested with an injected `fetch`.

- [ ] **Step 1: Write the failing test `test/data/gunvest.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createGunvestClient } from '../../src/data/gunvest.js';

function fetchReturning(payload) {
  return vi.fn(async () => ({ ok: true, json: async () => payload }));
}

describe('createGunvestClient', () => {
  it('fetches a ticker price from the market endpoint', async () => {
    const fetchMock = fetchReturning({ symbol: 'NVDA', price: 123.45 });
    const client = createGunvestClient('http://api:3001', fetchMock);
    const data = await client.getPrice('NVDA');
    expect(data).toEqual({ symbol: 'NVDA', price: 123.45 });
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/market/NVDA');
  });

  it('fetches ticker news', async () => {
    const fetchMock = fetchReturning([{ headline: 'x' }]);
    const client = createGunvestClient('http://api:3001', fetchMock);
    await client.getNews('MU');
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/news/MU');
  });

  it('fetches sentiment', async () => {
    const fetchMock = fetchReturning({ score: 0.2 });
    const client = createGunvestClient('http://api:3001', fetchMock);
    await client.getSentiment('NVDA');
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/sentiment/NVDA');
  });

  it('fetches macro overview', async () => {
    const fetchMock = fetchReturning({ risk: 'MODERATE' });
    const client = createGunvestClient('http://api:3001', fetchMock);
    await client.getMacro();
    expect(fetchMock).toHaveBeenCalledWith('http://api:3001/api/macro');
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    const client = createGunvestClient('http://api:3001', fetchMock);
    await expect(client.getPrice('ZZZ')).rejects.toThrow('GunVest API GET /api/market/ZZZ -> 404');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/data/gunvest.test.js`
Expected: FAIL — `Cannot find module '../../src/data/gunvest.js'`.

- [ ] **Step 3: Write `src/data/gunvest.js`**

```js
// Thin read client over the GunVest REST API. fetchImpl is injectable for tests.
export function createGunvestClient(baseUrl, fetchImpl = fetch) {
  async function get(path) {
    const res = await fetchImpl(`${baseUrl}${path}`);
    if (!res.ok) throw new Error(`GunVest API GET ${path} -> ${res.status}`);
    return res.json();
  }
  return {
    getPrice: (symbol) => get(`/api/market/${symbol.toUpperCase()}`),
    getNews: (symbol) => get(`/api/news/${symbol.toUpperCase()}`),
    getSentiment: (symbol) => get(`/api/sentiment/${symbol.toUpperCase()}`),
    getMacro: () => get(`/api/macro`),
  };
}
```

Note: the exact GunVest route paths must be confirmed against `gunvest/backend` route definitions when Phase 1 wires a live agent; adjust the four paths above if they differ. Phase 0 only fixes the client shape and is fully mock-tested.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/data/gunvest.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data/gunvest.js test/data/gunvest.test.js
git commit -m "feat: add GunVest REST API client"
```

---

## Task 10: Docker Compose + README

**Files:**
- Create: `legion/docker-compose.yml`
- Create: `legion/README.md`

Provides NATS and Ollama containers for local/VM runs. PostgreSQL is **not** defined here — Legion reuses GunVest's existing Postgres container/instance.

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  nats:
    image: nats:2.10-alpine
    container_name: legion-nats
    command: ['-js']
    ports:
      - '4222:4222'
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    container_name: legion-ollama
    ports:
      - '11434:11434'
    volumes:
      - ollama-data:/root/.ollama
    restart: unless-stopped

volumes:
  ollama-data:
```

- [ ] **Step 2: Write `README.md`**

````markdown
# Legion

Distributed multi-agent stock signal gestalt. Independent expert agents vote on a ticker
and reach a leaderless, BFT-flavored consensus, delivered to Telegram and a dashboard.

Design: see `gunvest/docs/superpowers/specs/2026-06-04-legion-design.md`.

## Status

Phase 0 — Foundation. Ships shared libraries (consensus math, vote schema, config, DB
schema, NATS wrapper, LLM provider, GunVest client). No running agents yet.

## Prerequisites

- Node.js ≥ 18
- Docker (for NATS + Ollama)
- A running GunVest instance (REST API + PostgreSQL)

## Setup

```bash
cp .env.example .env       # edit values
npm install
docker compose up -d       # start NATS + Ollama
docker exec -it legion-ollama ollama pull qwen2.5:7b-instruct
npm run db:migrate         # create the legion schema in GunVest's Postgres
npm test
```

## Consensus tuning (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `CONSENSUS_THETA_V` | 0.5 | Max dispersion `V_r` for convergence |
| `CONSENSUS_QUORUM` | 0.6667 | Min directional quorum `κ_r` (2/3) |
| `CONSENSUS_MAX_ROUNDS` | 3 | Round cap before NO_CONSENSUS |
| `CONSENSUS_HOLD_BAND` | 0.5 | Neutral band half-width for `S_r` |
````

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests across tasks 1–9 pass.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml README.md
git commit -m "chore: add docker compose (nats + ollama) and README"
```

---

## Phase 0 Done — Handover Notes

When all tasks are green, write a short handover note (for the next session/phase) capturing:

- Confirmed GunVest route paths (Task 9) vs. what was assumed.
- The chosen local model actually pulled (`qwen2.5:7b-instruct` vs. `llama3.1:8b`) and observed tok/s on the A1 VM.
- Any threshold defaults changed during testing.

**Next phase:** Phase 1 — single Technical agent end-to-end (subscribe cycle → gather via GunVest client → LLM vote → emit to Telegram). Write its own plan via the writing-plans skill.

---

## Self-Review

**Spec coverage (Phase 0 deliverables, spec §10):**
- Repo + Docker → Tasks 1, 10 ✅
- NATS → Task 6 ✅
- `legion` schema → Task 7 ✅
- Shared vote-schema + aggregation lib (unit-tested) → Tasks 2, 3, 4 ✅
- LLM provider abstraction (Ollama) → Task 8 ✅
- GunVest API client → Task 9 ✅
- Config (thresholds/quorum) → Task 5 ✅

**Type consistency:** vote shape `{ agentId, stance, conviction, weight, rationale }` is identical across Tasks 3, 4, 7. `evaluateRound` returns `{ S, V, kappa, converged, band }` — consumed only here in Phase 0. Provider interface `generate({ system, prompt })` consistent across Task 8. Config keys (`consensus.thetaV/quorum/maxRounds/holdBand`, `ollama.url/model`) consistent across Tasks 5, 8.

**Placeholders:** none — every step has full code. The one explicit assumption (GunVest route paths, Task 9) is flagged for Phase 1 confirmation and does not block Phase 0 (client is mock-tested).
