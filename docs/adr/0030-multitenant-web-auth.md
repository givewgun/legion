# ADR 0030 — Multi-Tenant Dashboard with Google OAuth

## Status
Accepted (2026-06-19).

## Context
The dashboard was served by `vite preview` (a dev server) and was open to anyone
with the tunnel URL. We want production-grade serving and multiple authenticated
users, each with their own watchlist and simulated portfolio, at ≈$0 and on the
shared Oracle free-tier VM.

## Decision
- Serve the built SPA with nginx (multi-stage image); nginx reverse-proxies
  `/api` to the existing Express `api` service. Replaces `vite preview`.
- Self-managed Google OAuth (authorization-code flow) in the `api` service, with
  Postgres-backed sessions (`express-session` + `connect-pg-simple`) and an email
  allowlist. The whole `/api` surface is gated by `requireUser`.
- The LLM debate engine, signals, and reliability stay **global/shared** — running
  the agent pipeline per user is infeasible on the VM (serial Ollama). Only the
  watchlist and portfolio config are per-user; the portfolio sim stays
  deterministic (no stored positions).

## Alternatives considered
- **Cloudflare Access** — edge auth, zero app code, but ties identity to one
  vendor's headers; chose in-app OAuth for portability.
- **Per-user signal/agent pipelines** — rejected: N× LLM compute the free VM can't
  supply.
- **Allowlist table** — rejected: an env var (`LEGION_ALLOWED_EMAILS`) is simpler
  and edits via the automated redeploy.

## Consequences
- New env/secrets flow through the existing deploy workflow; one out-of-repo step
  remains (registering the OAuth client in Google Cloud Console).
- Sessions are revocable (server-side). Adding a user = edit the allowlist + deploy.
