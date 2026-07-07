# Broker connections + Webull TH — build plan

Caveman plan. Spec: `../specs/2026-07-07-broker-connections-webull-design.md`.

1. **Schema + credentials crypto** — `schema.sql` broker_connections (+ partial unique
   active index); `src/broker/credentials.js` AES-256-GCM encrypt/decrypt (key =
   sha256(SESSION_SECRET)); repo CRUD (list/get-active/add/update/delete/activate).
2. **Webull adapter** — `src/broker/webull.js`: signer + six-method surface, injectable
   fetch/clock/nonce for tests. `test/broker/webull.test.js`.
3. **Factory + manager** — `broker.js` becomes `createBrokerFromConnection(conn, opts)`;
   new `src/broker/manager.js` caches instance on `(id, updated_at)`, returns null when no
   active row or live-without-allowLive. Config: drop `cfg.broker`, add
   `trading.allowLiveBroker`.
4. **Executor + runners** — executor takes `brokers` manager, resolves per tick, idles
   quietly when null; `run/emitter.js` always starts executor when gunvest exists;
   `run/api.js` + `portfolioRoutes` go through the manager.
5. **API routes + web UI** — `src/api/routes/broker.js` CRUD/activate/test (secrets
   write-only); Config-page "Broker connections" section in `web/src/pages/`.
6. **Sweep** — `.env.example`, `ci.yml` (stop templating IBKR_GATEWAY_URL), ADR 0036,
   runbook pointer, tests green, lint.

Each step = own commit on `claude/webull-broker-integration-364stm`; PR base
`claude/ibkr-paper-trading`.
