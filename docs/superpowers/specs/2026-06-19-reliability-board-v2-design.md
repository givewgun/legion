# Reliability Board v2 — design

Date: 2026-06-19

## Problem

The Reliability page (`web/src/pages/ReliabilityBoard.jsx`) shows almost
nothing and is confusing:

- Bar chart axis is `domain={[0,1]}`, but ρ is a skill-vs-baseline score
  centered at 1.0 (observed range ~1.0–1.2). Every bar clips at the top, so
  agents look identical.
- Table has only three columns: Agent, ρ, Sample. No wins/losses, no hit rate,
  no magnitude ("how big" were the wins/losses).
- Subtitle "How often each agent has been right (ρ)" mislabels ρ as a hit rate.
- No explanation of what ρ, calibration, info factor, or `sample = 50` mean.
  (`sample = 50` is the rolling recency window `WINDOW` from
  `src/consensus/reliability.js`, not a total — confusing without context.)

## Goal

Show, per agent: win/loss/hold record, hit rate, alpha magnitude (avg + best +
worst vs SPY), the learned dials with plain-language tooltips, and an
expandable list of recent calls. Add a "How to read this board" panel.

## Data contract

`GET /api/reliability` returns an array, one object per agent, ordered by `rho`
desc. Backward compatible: existing fields (`rho`, `sampleSize`, `calibration`,
`infoFactor`, `learnedPrior`, `flagged`, `flooredStreak`, `agentId`) stay.

New fields, all measured over the **same trailing 50-call window** ρ uses (so
counts reconcile with `sampleSize`):

```
{
  agentId, rho, calibration, infoFactor, learnedPrior, flagged, flooredStreak,
  sampleSize,            // unchanged: ρ window size (<= 50)
  wins,                  // directional calls graded correct
  losses,                // directional calls graded wrong
  holds,                 // stance === 0 calls in window
  hitRate,               // wins / (wins + losses); null when no directional calls
  avgAlpha,              // mean (forward_return - spy_return) over directional calls; null if none
  bestAlpha,             // max single-call alpha; null if none
  worstAlpha,            // min single-call alpha; null if none
  recent: [              // last ~10 resolved calls, newest first
    { symbol, stance, conviction, win, alpha }   // win: bool|null (null for hold); alpha: number|null
  ]
}
```

Definitions:
- **alpha** of one call = `forward_return - spy_return` (fraction; UI renders as
  `%`). Null when either return is null (legacy rows).
- **win/loss** = directional hit: `(stance > 0 && outcome === 1) || (stance < 0
  && outcome === 0)`. `stance === 0` is a hold (neither win nor loss).
- Window = 50 (`WINDOW`). All aggregates computed over each agent's newest 50
  resolved calls so they line up with the ρ sample.

## Backend

**`src/reliability/performance.js`** (new, pure, no DB):
- `summarizeAgents(rows, { window = 50 })` → `Map<agentId, summary>` where
  summary has `{ wins, losses, holds, hitRate, avgAlpha, bestAlpha, worstAlpha,
  sample, recent }`. Rows are `signal_votes ⋈ signals` newest-first; bucket per
  agent capped at `window`, then aggregate. Mirrors the bucketing in
  `src/reliability/update.js` (`WINDOW`, newest-first) for consistency.
- Pure and unit-testable: takes plain rows, returns plain objects. No DB import.

**`src/db/repo.js`**: add `getAgentBoardRows(limit)`:
```sql
SELECT sv.agent_id, s.id, s.symbol, sv.stance, sv.conviction, s.outcome,
       s.forward_return, s.spy_return
  FROM legion.signal_votes sv
  JOIN legion.signals s ON s.id = sv.signal_id
 WHERE s.resolved = true AND s.outcome IS NOT NULL
 ORDER BY s.id DESC
 LIMIT $1
```
`limit` = `WINDOW * (agent count headroom)` — reuse the same headroom pattern
as `getResolvedForecasts(WINDOW * 8)` so every agent's window is covered.

**`src/api/routes/reliability.js`**: merge dials + performance. Fetch the
leaderboard (dials) and board rows, run `summarizeAgents`, join by `agentId`,
emit the contract above. Agents present in the leaderboard but with no rows get
zeroed counts and null magnitudes.

## Frontend (`web/src/pages/ReliabilityBoard.jsx`)

- **Chart**: recenter ρ axis to `domain={[0.5, 1.5]}` with a `ReferenceLine` at
  `x={1.0}` labeled "baseline". Keep the per-agent color.
- **Subtitle**: reword (ρ = skill vs a coin-flip baseline, not hit rate).
- **Table** columns, each header wrapped in the existing `InfoTip`:
  - Agent
  - Record `W–L–H` (e.g. `28–17–5`)
  - Hit % (`hitRate`, `—` when null)
  - Avg α with best/worst (e.g. `+1.8%  (best +9.1% / worst −7.4%)`)
  - ρ (2dp)
  - Calibration (2dp)
  - Info (2dp)
  - Sample
- **Expandable row**: clicking an agent row reveals its `recent` calls — symbol,
  stance label (reuse stance labels in `web/src/lib`), conviction, a win/loss
  `Badge`, and alpha %. Collapsed by default.
- **"How to read this board"** collapsible panel (reuse `Card`): explains ρ
  (baseline 1.0), the rolling 50-call window, calibration, info factor, and that
  the dials re-weight each agent's future votes.

Reuse existing UI primitives: `Card`, `Badge`, `InfoTip`, `StatTile`,
`agentInfo`, `format` helpers. Match existing page styling (Tailwind classes as
in current board).

## Testing

- `test/reliability/performance.test.js`: aggregation correctness — wins/losses/
  holds, hitRate (incl. null when no directional calls), avg/best/worst alpha,
  null-return rows excluded from alpha but counted in W/L, window cap honored,
  recent list length and order.
- `test/api/reliability.test.js` (or extend existing api test): route returns
  the enriched shape; agent with no rows → zeroed/null fields; ordering by rho.
- Web: extend the reliability UI test — renders new columns, expand reveals
  recent calls, chart present. Match existing web test patterns.

## Out of scope (YAGNI)

- Per-regime breakdown on the board (data exists via `agent_regime_reliability`
  but not requested).
- A separate per-agent detail page (expandable row covers the need).
- Historical ρ-over-time charts.

## Execution

Two tasks via subagent-driven-development:
1. **Backend**: `performance.js` + repo method + route + backend tests. Defines
   and verifies the data contract.
2. **Frontend**: rebuild `ReliabilityBoard.jsx` against the contract + web test.
   Depends on Task 1's contract.
