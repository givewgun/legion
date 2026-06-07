# Legion Dashboard Redesign — Design

Date: 2026-06-07
Status: approved (design); spec pending user review

## Problem

The web dashboard is functional but visually plain and the UX is weak:

- **Home / Signals** is a flat list that piles signals on top of each other with no summary,
  grouping, or sorting.
- **Debate** cards are cramped and truncate each agent's rationale, and there is no view of how
  the agents move toward consensus across rounds.
- There is **no page that explains the system** — the consensus algorithm, backtesting, and the
  self-learning (reliability) loop are invisible to a user.
- The app has no visual identity, no shared component layer, and no client-side routing (a single
  in-memory tab switch), so pages drift and nothing is deep-linkable.

## Goals

- A cohesive visual identity ("Calm Light": white, soft shadows, indigo accent, roomy spacing).
- A scannable home, a debate view with full rationale + a convergence "flow", and an animated
  explainer page covering consensus + backtest + self-learning.
- Deep-linkable routes and a shared design-system layer so pages stay consistent.
- No regressions: all existing data continues to render; tests stay green.

## Non-Goals

- No dark mode (light only — YAGNI).
- No backend/API changes. Every view derives from existing endpoints.
- No change to the consensus algorithm, backtest, or reliability math.

## Decisions (locked during brainstorming)

- **Visual direction:** Calm Light (white, indigo `#4f46e5` accent, soft shadows, `rounded-xl`).
- **Home layout:** dense sortable table + a slim summary strip on top.
- **Debate layout:** stance-flow line chart (hero) + conversation-thread rounds.
- **Explainer layout:** living animated pipeline (hero) + scrollytelling sections below.
- **Routing:** add `react-router-dom`.
- **Dependencies:** add `react-router-dom`, `framer-motion`, `recharts`, `lucide-react`.

## Architecture

### Dependencies (web)

Add to `web/package.json`: `react-router-dom`, `framer-motion`, `recharts`, `lucide-react`.

### Design system

- **Theme** in `web/tailwind.config.js` `theme.extend`:
  - colors: `brand` (indigo scale), semantic `buy` (green), `sell` (red), `hold` (slate).
  - `boxShadow` soft tokens, `borderRadius` default to `xl`, spacing kept on Tailwind defaults.
- **Primitives** in `web/src/ui/`, each one small and independently testable:
  - `Card` — white surface, border, soft shadow, padding.
  - `Badge` — stance/band pill, colored by semantic token.
  - `StatTile` — label + value summary tile.
  - `ConvictionBar` — 0–1 horizontal bar, colored by band.
  - `AgentAvatar` — circular icon badge for an agent (icon + color).
  - `PageHeader` — title + optional subtitle/actions.
  - Reuse existing `InfoTip` (`web/src/components/InfoTip.jsx`) as the tooltip primitive.
- **Agent identity** in `web/src/lib/agents.js`: `agent_id → { label, color, Icon }`.
  - technical → `LineChart`; news → `Newspaper`; social → `Users`; contrarian → `Zap`
    (lucide-react icons). Fallback entry for unknown agent ids.

### App shell + routing

`web/src/App.jsx` becomes a `BrowserRouter` shell: redesigned top nav (logo, active-state links,
new "Learn" entry) + `<Routes>`. Routes:

| Path | Page |
| --- | --- |
| `/` | Signals (home) |
| `/debate`, `/debate/:symbol`, `/debate/:symbol/:cycleId` | Debate |
| `/learn` | How it works |
| `/reliability` | Reliability |
| `/backtest` | Backtest |
| `/config` | Ticker config |

Debate selection (symbol, cycle) is reflected in the URL so a debate is shareable and the back
button works. The page reads params from the router and drives its existing fetch logic.

## Pages

### Home / Signals (`/`)

- **Summary strip:** four `StatTile`s — total signals, bullish/bearish split, average conviction,
  time since last run — all computed client-side from `/api/signals`.
- **Table:** one sortable table — ticker, band `Badge`, inline `ConvictionBar`, age. Default sort by
  recency; clicking a column header re-sorts. Clicking a row navigates to `/debate/:symbol`.
- Empty/error states preserved.

### Debate (`/debate/...`)

- Keep the master–detail browser already on main (searchable ticker list + cycle drill-down),
  refit to the design system and wired to routes.
- **Hero chart:** recharts `LineChart` — one line per agent (agent colors), x = round number,
  y = stance (−2..+2). A reference line marks the converged S. Series are derived client-side by
  pivoting the existing `rounds[].votes[]` data (agent → stance per round).
- **Conversation thread:** rounds rendered as a thread. Each agent message = `AgentAvatar` +
  `Badge` + conviction + **full rationale that wraps (never truncated)**. For round ≥ 2, show a
  "re: peers" strip (the prior round's other agents — matching what the engine feeds each agent per
  `src/agents/peers.js`) and a `▲ / ▼` delta vs that agent's previous-round stance.
- No backend change; everything comes from `/api/cycles/:id`.

### Learn / How it works (`/learn`)

- **Hero — living pipeline:** an always-on animated diagram (framer-motion path / motion pulse):
  data → agents → consensus → signal → outcome → reliability → back into agent weights. Hovering or
  tapping a node expands a short explanation. Conveys the self-learning feedback loop at a glance.
- **Scrollytelling sections** that animate in with `whileInView`:
  1. The debate loop — 4 agents vote, read peers, revise.
  2. Convergence — S (weighted mean stance), V (dispersion), κ (directional quorum), and the
     `κ ≥ quorum AND V ≤ θ_v` rule. Formulas taken from `src/consensus/aggregate.js`.
  3. Backtesting — hit rate, PnL vs SPY/QQQ benchmarks, horizon.
  4. Self-learning — reliability ρ per agent and how it feeds future weighting.
- Static content; no data fetch.

### Reliability (`/reliability`)

- Horizontal `BarChart` of ρ per agent (agent colors) with sample size; keep the exact-numbers table
  below. Data from `/api/reliability`.

### Backtest (`/backtest`)

- Per-symbol grouped bars: strategy PnL vs SPY vs QQQ, plus hit rate; keep the table below. Data from
  `/api/backtest`.

### Config (`/config`)

- Refit `TickerConfig` to the design system (Card/Badge/PageHeader). No behavior change.

## Error handling

- Preserve existing per-page error and empty states; restyle them with the design system.
- Charts must tolerate empty/short series (e.g. a single round) without crashing.

## Testing

Vitest + @testing-library/react (existing setup). Focus on behavior and wiring, not pixels.

- **Routing:** each route renders its page; unknown selection states render empty prompts.
- **Home:** summary tiles compute from signals; table sorts; row click navigates to the debate route.
- **Debate:** thread renders **full** rationale (assert the untruncated text is present); `▲/▼`
  deltas and "re: peers" appear for round ≥ 2; chart receives the pivoted series.
- **Agent map / primitives:** `AgentAvatar`, `Badge`, `ConvictionBar` render expected
  label/color/width; `agents.js` returns a fallback for unknown ids.
- **Reliability/Backtest:** chart + table receive the fetched rows.
- **Charts in jsdom:** recharts `ResponsiveContainer` has no size in jsdom — render charts with an
  explicit width/height (or a test wrapper) and assert on data/props rather than rendered geometry.
- **Animation:** assert content is present; do not assert on motion.
- Keep all currently-passing web and backend tests green.

## Implementation order (for the plan)

1. **Foundation** — add deps; theme in tailwind config; `web/src/ui/` primitives; `lib/agents.js`.
   Shared by everything; lands first.
2. **Shell + routing** — `App.jsx` → router + redesigned nav.

Then, building on 1–2 (largely independent, suitable for parallel subagents):

3. Home / Signals.
4. Debate (chart + thread).
5. Learn / How it works.
6. Reliability + Backtest.
7. Config refit.

Execution uses subagent-driven development in caveman mode.

## Risks / notes

- recharts + jsdom sizing is the main test friction — handled by explicit chart dimensions in tests.
- Bundle size grows (framer-motion + recharts). Acceptable per the dependency decision; rely on
  tree-shaking and avoid importing whole icon sets (named imports only).
- "Agent influence" is shown only as real, data-backed stance moves (`▲/▼`) and prior-round peer
  context — not a fabricated "A persuaded B" edge graph.
