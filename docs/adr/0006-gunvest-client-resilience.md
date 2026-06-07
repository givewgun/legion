# ADR 0006 — Resilient GunVest Data Client

## Status

Accepted (2026-06-06).

## Context

The same burst that saturates Ollama (ADR 0005) also hammers the GunVest REST API: a scheduler
sweep fans every enabled ticker out at once and each agent process gathers all of them
concurrently (× up to 3 rounds), bursting a single-threaded GunVest. Unbounded, this produced
transient `fetch failed` (ECONNRESET / connect-timeout) scattered across agents — each request
fine in isolation, so the fault was self-inflicted load, not the data.

## Decision

Route every request in [`src/data/gunvest.js`](../../src/data/gunvest.js) through three guards,
all constructor-tunable:

- a **bounded-concurrency limiter** (`maxConcurrent`, default 6) so the client never creates a
  thundering herd of its own;
- a **per-request `AbortController` timeout** (`timeoutMs`, default 8000);
- **retry with jittered exponential backoff** (`retries`, default 2) on transient transport
  errors and retryable statuses (429/500/502/503/504). Non-retryable statuses (e.g. **404**)
  fail fast.

The underlying cause is surfaced in the thrown message (`describeError`) so any remaining
abstain is diagnosable. `getCandles` and all read methods share the one path.

## Alternatives considered

- **No client-side limiting, scale GunVest** — GunVest is itself the shared free service;
  fixing load at the consumer is cheaper and local.
- **A shared library between this and the Ollama provider** — both now use the same limiter/retry
  shape; unifying `gunvest.js` onto `src/util/resilient.js` is a tracked follow-up, deliberately
  not blocking.
- **Retry everything including 404** — would mask genuine "no such ticker/route" errors; 404
  fast-fails on purpose.

## Consequences

- Transient `fetch failed` from self-inflicted bursts is eliminated at the one shared seam.
- The limiter is **per process**, so ~4 agent processes can still place ~24 concurrent requests
  at GunVest in aggregate; retry/backoff covers the cross-process overlap. A shared cache for
  market-wide calls (`getMacro`, `getStockFearGreed`) and scheduler staggering are noted
  follow-ups.
