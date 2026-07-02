# ADR 0033 — Share the Reasoning, Not Just the Vote

## Status
Accepted (2026-07-02).

## Context
When a round fails to converge, the cycle is republished with the prior round's
votes and each agent confronts its peers' dissent (`summarizePeers`). Until now
that dissent block carried only the numeric verdict plus the one-or-two-sentence
`rationale` the vote JSON asks for. With thinking models (qwen3, gpt-oss) the
model produces a much richer reasoning trace — the actual math and evidence
behind the stance — but the provider layer captured it only for metrics and
threw it away. An agent re-voting against a peer's `SELL (conviction 0.7):
"overvalued"` had to re-guess *why* the peer thought so, which makes revision
rounds shallower than they need to be: agents react to conclusions, not
arguments.

## Decision
- Providers return the reasoning trace: the Ollama provider's `generate` returns
  `{ text, thinking }` (thinking-mode chunks), the OpenAI-compatible provider
  maps `reasoning_content`/`reasoning`, and the tiered provider passes it
  through with its model/source tags. `normalizeGenerate` fills `thinking: null`
  for anything older, so the contract stays absorbing.
- The agent runner attaches the trace to the vote as an optional `thought`
  field (null for non-thinking models and abstains). Models that emit inline
  `<think>…</think>` blocks instead of the structured field (qwen3 without the
  `think` request flag) have them split out of the answer text and used as the
  thought. The stored thought is capped (`MaxThoughtChars`, 6000) so a runaway
  trace cannot bloat the NATS payload or the pending-vote row.
- `summarizePeers` quotes each peer's thought (indented, capped at
  `PeerThoughtChars`, 900 per peer) under its vote line, so a revision round
  argues with the peer's actual logic. No knob: a vote without a thought renders
  exactly as before, so a non-thinking panel is byte-identical.
- The thought is persisted on `legion.votes` and replayed in the dashboard's
  debate viewer behind a collapsed "Show reasoning" disclosure.
- A new `oracle_think` runtime knob (tribool, like `home_think`) lets the
  Oracle VM run a thinking model without a redeploy; `OLLAMA_THINK` remains the
  env default.

## Alternatives considered
- **Share the full trace untruncated** — rejected: three peers × tens of KB
  overwhelms a small local model's context and buries the market data.
- **Summarize the trace with another LLM call before sharing** — rejected: adds
  a serial LLM call per vote per round on an already CPU-bound box.
- **A feed-through toggle (share on/off)** — rejected: presence of the thought
  already gates the behaviour; a panel of non-thinking models is unchanged.

## Consequences
- Votes (bus + `legion.votes` + `pending_votes` JSONB) carry an optional
  `thought`; the consensus math ignores it — S/V/κ and the reliability loop are
  untouched, so replayability (ADR 0001) holds.
- Round-2+ prompts grow by up to ~900 chars per thinking peer; watch cycle
  latency on the Oracle tier when enabling `oracle_think`.
- Reasoning traces from thinking models are now auditable per round in the
  debate viewer.
