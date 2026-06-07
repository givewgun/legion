# Debate Tab Redesign — Design

Date: 2026-06-06
Status: approved

## Problem

The Debate tab has three defects:

1. **Auto-fill bug** — `App.jsx` keeps a shared `symbol` state defaulting to `'NVDA'`, and `DebateViewer` pre-loads cycles for it. The tab opens pre-filled with NVDA and shows only that ticker, with no way to discover what other data exists.
2. **Horizontal overflow** — `VoteRow` is a flex row whose rationale uses `truncate` without `min-w-0` on the flex child, so truncation never engages and long rationales push the card past the `max-w-3xl` container.
3. **No guidance / no dates** — the S / V / κ metrics are shown as bare numbers with no explanation of what they mean or how the consensus algorithm behaves, and nothing on the card tells the user *when* a cycle ran, so there is no way to tell whether they are looking at the latest data.

## Goals

- Discoverable: show all tickers that actually have debate data first; let the user drill in.
- Keep a search bar.
- Explain S / V / κ via inline tooltips, and the overall algorithm via a guide widget.
- Show timestamps on the data.
- No horizontal overflow; intuitive UX.

## Design

### Backend — one new endpoint

- `repo.listTickersWithCycles()` — `DISTINCT ON (symbol)` over `legion.cycles`, returning
  `{ symbol, latest_cycle_id, latest_status, latest_started_at, cycle_count }`, ordered by
  `latest_started_at DESC NULLS LAST`. Only symbols that have at least one cycle appear.
- `GET /api/cycles/tickers` in `src/api/routes/cycles.js`. **Must be registered before** the
  existing `GET /:id` route, otherwise `/:id` matches `/tickers` and returns a 400.
- `api.listCycleTickers()` in `web/src/api/client.js` → `get('/api/cycles/tickers')`.

### Frontend — master–detail

Replaces `DebateViewer.jsx`. The App-level conditional `<input>` and the `'NVDA'` default are
removed (kills the auto-fill bug); `App` no longer threads `symbol` into the Debate tab.

Layout:

- **Top (full width):** collapsible "How consensus works" guide panel, collapsed by default.
- **Search bar:** filters the ticker list (client-side, case-insensitive substring on symbol).
- **Left master column:** ticker list from `listCycleTickers()`. Each row = symbol + latest cycle
  date + status badge. Selecting a ticker loads its cycles via `listCycles(symbol)` and shows them
  indented beneath the selected ticker (id + date + converged/status). Selecting a cycle loads the
  debate.
- **Right detail column:** selected cycle's rounds. Header = `symbol — cycle #id · <date> (status)`.
- **Empty state:** "Pick a ticker to see its debate." Nothing is pre-selected.

### Guide + tooltips

Content is taken from the real math in `src/consensus/aggregate.js`:

- **S** — weighted mean stance `Σ(W·c·s) / Σ(W·c)`; mapped to a BUY / HOLD / SELL band.
- **V** — weighted dispersion (variance of stance around S); lower means agents agree.
- **κ** — weighted fraction of votes whose side agrees with the aggregate side.
- Convergence rule (guide footer): a round converges iff **κ ≥ quorum AND V ≤ θ_v**.

A reusable `<InfoTip>` renders an ℹ️ marker that reveals a small tooltip on hover/focus (CSS
group-hover + focus, accessible via keyboard). One `InfoTip` sits next to each of S / V / κ in
`RoundCard`. The guide panel gives the plain-language debate loop: four agents (technical, news,
social, contrarian) each cast a weighted stance (−2..+2) with a conviction (0..1); they revise over
rounds until the round converges.

### Dates

`fmtDate(ts)` helper in `web/src/lib/format.js` (short, locale date; returns `''` for nullish).
Shown on ticker rows, cycle rows, and the cycle detail header (started_at; ended_at appended when
present).

### Overflow fix

`VoteRow` rebuilt as a CSS grid: fixed columns for `agent | stance | conviction` and a final
rationale cell with `min-w-0 truncate` so the row never exceeds the container width.

## Testing

- Backend: test the new route returns only symbols with cycles, newest first, with the expected
  shape (extend existing API/route tests).
- `web/test/lib/format.test.js`: `fmtDate`.
- `web/test/pages/DebateViewer.test.jsx` (new): ticker list renders from the endpoint, no auto-fill
  / no pre-selected ticker, drill-down ticker→cycle→debate works, S/V/κ InfoTips present, dates
  shown.
- `RoundCard` test updated for the InfoTip markers / date if needed.

## Out of scope

- No change to the consensus algorithm itself.
- No new persisted fields; all timestamps already exist (`cycles.started_at` / `ended_at`).
