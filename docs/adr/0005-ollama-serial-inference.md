# ADR 0005 — Serialize Ollama Inference Under Concurrent Load

## Status

Accepted (2026-06-06). Amended (2026-06-10): `OLLAMA_KEEP_ALIVE` changed from `-1` to `30m` —
see Amendment below.

## Context

On the A1 VM (ARM cores, CPU-only Ollama running `qwen2.5:7b`), a single 7B inference already
pins every core. A scheduled sweep, however, fires all four voting agents across all enabled
tickers at once (~20 concurrent `/api/generate` calls). The box thrashes, requests queue, and
any request waiting past undici's hidden ~300 s headers-timeout surfaces as
`[news] cycle error: fetch failed`. Each request succeeds in isolation, confirming the cause is
**inference contention**, not bad data. The original provider did a bare `fetch(..., {stream:false})`
with no timeout, no retry, and no concurrency cap — no backpressure.

## Decision

Make inference strictly serial across the box and bound submission per process.

- **Ollama server:** `OLLAMA_NUM_PARALLEL=1` (exactly one inference at a time, on all cores)
  and `OLLAMA_KEEP_ALIVE=-1` (keep the ~5 GB model resident, never reload between calls).
- **Provider** ([`src/llm/ollama.js`](../../src/llm/ollama.js)): a single-flight limiter
  (`maxConcurrent`, default 1) so each agent holds ≤1 in-flight call; an `AbortController`
  deadline (`timeoutMs`, default 300000) plus a custom undici `Agent({ headersTimeout: 0,
  bodyTimeout: 0 })` so *our* timeout is the only deadline; and `retryAsync` on transient
  transport drops and retryable 5xx. A timeout (`AbortError`) is treated as **saturation and is
  not retried** — retrying a saturated box only deepens the thrash; the agent abstains instead.
- Shared primitives `createLimiter`/`retryAsync` live in
  [`src/util/resilient.js`](../../src/util/resilient.js).

## Alternatives considered

- **Durable NATS inference-worker** (Approach B): agents publish `{system,prompt}` to an
  `llm.generate` queue group drained serially by one worker owning the only Ollama client.
  Cleaner global concurrency = K workers, but `NUM_PARALLEL=1` already gives the serial
  guarantee, so this is documented and deferred (YAGNI).
- **Let undici's default timeout fire** — it pre-empts legitimately-queued requests, which is
  exactly the failure we are removing.
- **GPU / larger box** — defeats the ≈$0 goal.

## Consequences

- `fetch failed` from contention is eliminated; a serialized sweep takes tens of minutes, fine
  on the 4 h cadence.
- A genuinely saturated request abstains cleanly with a diagnosable cause (`err.cause` surfaced).
- Throughput is capped at one inference at a time — the explicit trade-off; scaling needs
  Approach B or a second model server.

## Amendment (2026-06-10): `OLLAMA_KEEP_ALIVE=30m`, not `-1`

In production, `KEEP_ALIVE=-1` caused unbounded container memory growth: ~1 GB per sweep,
stepping from 5.5 GiB to 10.3 GiB over a day and never released. Evidence isolated the leak
to the single long-lived runner process (constant PID count, no new block I/O — so not a
second model or runner; the growth is heap/cache accumulated inside the resident runner
across repeated `/api/generate` calls).

Since the runner's internals are not ours to fix, we bound its lifetime instead:

- `OLLAMA_KEEP_ALIVE=30m` — each request resets the timer, so the model stays warm for an
  entire serialized sweep (calls are back-to-back, minutes apart). 30 minutes after the
  last call the runner exits and *all* its memory is reclaimed. The cost is one ~5 GB model
  load at the start of each 4 h cycle (usually served from page cache, not disk).
- `mem_limit: 12g` on the container (prod compose) as a backstop: page cache is reclaimed
  under pressure, and a runaway runner is OOM-killed and restarted (`restart:
  unless-stopped`) instead of starving the gunvest stack on the shared VM.

The original goal of `-1` — never reload *between calls within a sweep* — is preserved.
