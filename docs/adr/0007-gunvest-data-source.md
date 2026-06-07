# ADR 0007 — GunVest as the Sole Data Source and Shared Datastore

## Status

Accepted (2026-06-04).

## Context

Legion needs market prices, candles, news, sentiment, and macro data, somewhere to persist its
own cycles/signals, and a delivery channel. A sibling project, **GunVest**, already provides a
REST API over exactly this data, runs a PostgreSQL instance, and operates a Telegram bot — all
on the same VM. Re-implementing data ingestion (Yahoo/Finnhub fetching, rate-limit handling,
caching) would duplicate hard-won, already-maintained code.

## Decision

Legion is a **read-only consumer** of GunVest and never fetches market data itself. The single
seam is [`src/data/gunvest.js`](../../src/data/gunvest.js) (`getPrice`, `getCandles`, `getNews`,
`getSentiment`, `getStockFearGreed`, `getMacro`). Legion's own state lives in an **isolated
`legion` schema** inside GunVest's Postgres (one DB, separate namespace — see ADR 0013), and
signals are delivered through GunVest's Telegram bot
([`src/emit/telegram.js`](../../src/emit/telegram.js)). Contrarian-only positioning feeds that
GunVest does not expose (CBOE put/call, AAII, NAAIM) are fetched directly, each degrading to
`null` rather than throwing.

## Alternatives considered

- **Own data pipeline** — full control, but duplicates GunVest and doubles maintenance/cost for
  no benefit; rejected.
- **A separate Legion database** — cleaner isolation, but a second Postgres on the free VM is
  wasteful; a schema namespace gives isolation without another server.
- **Own notification channel** — GunVest's Telegram bot already reaches the user; reusing it is
  zero-cost.

## Consequences

- GunVest stays the single source of truth; Legion cannot drift from it.
- Legion's blast radius on GunVest is read traffic only, bounded by ADR 0006.
- A coupling: GunVest route/response shape changes can break Legion's `gather` mappings — the
  mappings are localized to the one client so the fix stays in one file.
- The contrarian HTML scrapes are layout-fragile by nature and degrade to `null` by design.
