# ADR 0031 — Ollama via the Official Client, Streaming

## Status
Accepted (2026-06-20).

## Context
`src/llm/ollama.js` hand-rolled the call: a `fetch` POST to `/api/generate` with
`stream: false`, reading `.response`. This works for small `qwen2.5` models but
breaks for the home-PC tier running `gpt-oss:20b` in thinking mode. A reasoning
model spends a long time on thinking tokens before the first answer byte; with a
buffered (non-stream) response, undici's 300s *headers* timeout
(`UND_ERR_HEADERS_TIMEOUT`) can fire before any byte arrives, so a healthy model
"bugs out". The non-stream read also gave no visibility into thinking activity.

## Decision
- Call Ollama through the official `ollama` npm client, with `stream: true`.
  Accumulate `chunk.response` into the answer and `chunk.thinking` into a thinking
  buffer. An abort timer on the streaming iterator bounds total generation — our
  explicit budget rather than undici's hidden headers timeout. The first chunk
  arrives quickly, so a long thinking phase no longer trips a read timeout.
- The provider still returns only the final answer string; the contract and the
  error-message shapes (`Ollama request failed: <status>`, `... timed out after
  <ms>ms`) are unchanged. Concurrency limiter and p-retry wrappers are kept.
- Thinking length is recorded to `legion_ollama_thinking_chars` and a debug log,
  giving operators a signal that thinking mode is active.

## Alternatives considered
- **Keep hand-rolled fetch, non-stream** — rejected: the headers-timeout-mid-
  thinking failure is intrinsic to buffering a slow reasoning response.
- **Hand-rolled fetch with manual SSE streaming** — rejected: re-implements what
  the official client already does (chunk framing, thinking field, abort).
- **Switch the whole provider layer (openai/gemini too)** — out of scope; the
  `ollama` client does not speak the OpenAI-compatible protocol those use.

## Consequences
- New runtime dependency (`ollama`); the openai/gemini path stays on `fetch`.
- The Ollama provider's injectable changes from `fetchImpl` to a `clientFactory`;
  `provider.js` no longer threads `fetchImpl` into it (still used by the readiness
  probe). See ADR 0003.
- Thinking-mode behaviour is now observable via the new metric.
