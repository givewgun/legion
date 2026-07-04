# Runbook: IBKR Paper-Trading Execution

This runbook documents the operator setup and rollout for Legion's execution layer: an
[IBeam](https://github.com/Voyz/ibeam) gateway container that logs into an **IBKR paper
account**, and an executor worker (inside the emitter process) that drains emitted signals into
real DAY market orders against that account. Design/rationale: [ADR 0035](adr/0035-ibkr-paper-execution.md).

---

## 1. IBKR Paper Account Setup

1. Create (or reuse) an Interactive Brokers account at
   [interactivebrokers.com](https://www.interactivebrokers.com/). Every IBKR account — even one
   used purely for paper trading — is provisioned with a linked **paper trading account**, whose
   account id always starts with `D` (e.g. `DU1234567`). This `D` prefix is what
   `src/broker/ibkr.js` checks at startup (see §4, paper-account assertion).
2. Find the paper account's own username in **Settings → Paper Trading Account** on the IBKR
   account management site — it is a *separate* login from your real username (commonly the
   real username with a suffix). IBeam needs this paper username/password, not your live
   credentials.
3. **Reset caveats**: IBKR periodically resets paper accounts (typically weekly, and always on a
   fresh provisioning) — balances, positions, and order history all revert to the default seed
   equity. This is why Legion keeps its **own** equity history
   (`legion.paper_equity_snapshots`, taken by the executor) rather than trusting the Client
   Portal API's own performance history: a paper reset would otherwise silently truncate the
   equity curve. A reset does **not** require any Legion-side action — the executor picks up the
   new (reset) equity/positions on its next tick and sizes against them; the equity curve will
   show a step change on the chart, which is expected and not a bug.

---

## 2. `.env.ibeam` Creation

IBeam needs its own credentials file — **never commit it** (`.env.ibeam` is already in
`.gitignore` alongside `private/`). On the host running Legion's Docker Compose stack (dev
machine or the prod VM), create it next to `docker-compose.yml`:

```bash
cat > .env.ibeam <<'EOF'
IBEAM_ACCOUNT=your_paper_username
IBEAM_PASSWORD=your_paper_password
EOF
chmod 600 .env.ibeam
```

Both compose files (`docker-compose.yml` and `docker-compose.prod.yml`) declare the `ibeam`
service with `env_file: [{ path: .env.ibeam, required: false }]`, so **`docker compose up`
degrades gracefully if this file is missing** — the rest of the stack (including a fresh deploy)
comes up normally; only the `ibeam` container itself starts without credentials and fails IBKR
auth until `.env.ibeam` is created and the container is restarted. Still create `.env.ibeam`
*before* the first deploy/up on any host, dev or prod, so the gateway chip goes green immediately
instead of sitting red.

Legion's own `.env` (not `.env.ibeam`) needs the gateway URL pointed at the `ibeam` service by
its compose service name:

```
IBKR_GATEWAY_URL=https://ibeam:5000/v1/api
```

`.github/workflows/ci.yml`'s deploy job regenerates `.env` on the VM from GitHub Secrets on
*every* deploy (the same `HOME_OLLAMA_URL`-style templating used for the PC model server). The
`sudo tee .env` heredoc includes the literal `IBKR_GATEWAY_URL=https://ibeam:5000/v1/api` line, so
it survives every redeploy without a hand-edit. The `LEGION_TRADING_*` / `LEGION_ALLOW_LIVE_BROKER`
vars are deliberately **not** templated into `.env` — their safe-by-default values
(`enabled=false`, `dryRun=true`) come from `.env.example`/code defaults, and any non-default
override belongs in `runtime_config` (toggled from the dashboard), not baked into the deploy
template.

`.env.ibeam` itself is **not** part of the CI-generated `.env` and is unaffected by deploys —
it only needs to exist once on the VM's `/opt/legion/app` directory.

---

## 3. First-Deploy Rollout

Trading ships **off by default** — a fresh deploy is inert
(`LEGION_TRADING_ENABLED=false`, `LEGION_TRADING_DRY_RUN=true` in `.env.example`). Bring it up
in three dashboard steps, no redeploy needed between them:

1. **Deploy.** `docker compose up` (or the CI deploy) with `.env.ibeam` present and
   `IBKR_GATEWAY_URL` set. Confirm the gateway chip on the Paper Trading page goes green
   (`Gateway: <accountId>`) — this means IBeam has logged in and Legion can reach it. The
   executor is idling (`trading_enabled` is off): no orders are placed yet.
2. **Enable with dry-run.** In the dashboard's Settings page, turn **`trading_enabled`** (labeled
   "Paper trading (kill switch)") on, leaving **`trading_dry_run`** (labeled "Trading dry-run
   (log only)") on. The executor now runs its full pipeline — gates, equity/position fetch,
   sizing, dust filter — for every pending order intent, but stops short of calling
   `placeOrder`. Watch the order log on the Paper Trading page over a few signal cycles: entries
   land with status `skipped` and reason `dry-run`, showing the quantity and target weight it
   *would* have submitted. This is the checkpoint to sanity-check sizing before anything reaches
   the broker.
3. **Go live-paper.** Once the dry-run order log looks sane, turn **`trading_dry_run`** off from
   the same Settings page. The next executor tick submits real DAY market orders for any
   still-pending intents, and every new signal from then on trades for real (on the paper
   account).

Both toggles are `runtime_config` rows (see `src/config/runtime-keys.js`) — changing them takes
effect on the executor's next poll (~15s), no restart required.

---

## 4. Reading the Order Log

The Paper Trading page's order table (one row per `legion.order_intents` entry, newest first)
shows these statuses:

| Status | Meaning |
| --- | --- |
| `pending` | Intent written by the emitter; the executor hasn't processed it yet, or a transient error (state-fetch failure, gateway unreachable) is holding it for retry on the next tick. |
| `submitted` | A DAY market order was placed at the broker (`broker_order_id` recorded); the executor re-checks its status every tick until it fills, is cancelled, or expires. A `submitted` order resting overnight (placed off-hours) is normal — it will fill or expire at the next session open. |
| `filled` | The broker reported a fill; `fill_qty`/`fill_price` are recorded and an equity snapshot was taken immediately after. |
| `skipped (dust)` | The sized order was smaller than `trading_min_order_notional` (default $50) or rounded to 0 shares — not worth sending. |
| `skipped (dry-run)` | `trading_dry_run` was on when this intent was processed; the would-be quantity/target weight are recorded but nothing was sent to the broker. |
| `failed` | One of three causes, each recorded in the error text: the broker rejected the order (read it — rejections are not auto-retried on purpose); a resting DAY order was cancelled/expired unfilled; or a `submitted` order's `cOID` was no longer found at the broker on a status check ("order not found at broker (lost after submit)"). A new signal for the same symbol re-sizes against the account's *actual* position, so a failed order self-corrects on the next signal rather than needing a manual resubmit. |

A gap between a signal appearing elsewhere in Legion (Telegram, the Signals page) and an order
intent showing up here means the intent write itself failed at emit time — check the emitter's
logs for `order intent write failed`; the signal is unaffected (ADR 0035 guards this write so it
never blocks emission).

---

## 5. Kill-Switch Procedure

To stop all trading immediately, without touching the deploy:

1. Open the dashboard's Settings page.
2. Turn **`trading_enabled`** ("Paper trading (kill switch)") off.
3. The executor checks this flag at the top of every tick (~15s) and no-ops entirely when it's
   off — no new orders are placed, and any intents already `pending` or `submitted` are left
   exactly as they are (a `submitted` order already resting at the broker is **not** cancelled;
   the kill switch stops new activity, it does not unwind existing orders).

To resume, turn `trading_enabled` back on. Consider also turning `trading_dry_run` on first if
you want to re-verify sizing before live orders resume (same as the first-deploy rollout, §3).

---

## 6. Gateway-Red Troubleshooting

The gateway chip on the Paper Trading page turns red when `gateway.authenticated` is false —
either IBeam isn't configured (`IBKR_GATEWAY_URL` unset — chip reads "Gateway: not configured")
or it's configured but not authenticated (chip reads "Gateway: down"). While red, the executor
leaves intents `pending` and retries; the equity curve and order-log history (both DB-backed)
keep serving normally.

1. Check the IBeam container's own logs first:

   ```bash
   docker logs legion-ibeam
   ```

   Common causes: expired/incorrect paper credentials in `.env.ibeam`, IBKR's 2FA challenge
   waiting on an interactive step IBeam couldn't complete headlessly, or the paper account
   session having been logged out from IBKR's side (e.g. a concurrent login from the IBKR
   mobile/desktop client, which force-logs-out the API session).
2. Restart the container to force a fresh login attempt:

   ```bash
   docker restart legion-ibeam
   ```
3. If restarting doesn't clear it, verify `.env.ibeam` still has the correct paper
   username/password (§2) and that the paper account hasn't been reset in a way that changed
   credentials (rare, but re-provisioning does happen — recheck IBKR account management).
4. Once `docker logs legion-ibeam` shows a successful authenticated session, the gateway chip
   should turn green on the Paper Trading page's next poll (it refreshes every 20s) without any
   Legion-side restart — the `api` and `emitter` services just make fresh REST calls against
   whatever IBeam reports.

Legion's own `/ready` endpoint is intentionally **not** coupled to gateway health (ADR 0035) —
an IBeam outage does not fail Legion's liveness check or block signal emission, only trading.

---

## 7. Environment Variables Reference

Cross-checked against `src/config/index.js` and `.env.example`:

| Variable | Default | Effect |
| --- | --- | --- |
| `IBKR_GATEWAY_URL` | *(empty)* | Base URL of the IBeam gateway, e.g. `https://ibeam:5000/v1/api`. Empty = broker unconfigured; the executor idles and `/api/portfolio` reports the gateway as not configured. |
| `LEGION_ALLOW_LIVE_BROKER` | `false` | Must stay `false` for paper trading. `true` allows a non-`D`-prefixed (live) account id past the adapter's paper-account assertion — do not set this unless you deliberately intend to trade a live account. |
| `LEGION_TRADING_ENABLED` | `false` | Static default for the `trading_enabled` runtime knob (the kill switch). The dashboard toggle overrides this per-deploy without a restart. |
| `LEGION_TRADING_DRY_RUN` | `true` | Static default for the `trading_dry_run` runtime knob. |
| `LEGION_TRADING_MIN_NOTIONAL` | `50` | Static default for the `trading_min_order_notional` runtime knob — dust filter, USD. |
| `LEGION_TRADING_BASE_WEIGHT` | `0.05` | Base target-weight fraction fed to `computeSizing` (`src/sizing/engine.js`) before conviction/quality scaling. No runtime override — env-only. |
| `LEGION_TRADING_MAX_PER_NAME` | `0.10` | Cap on target weight per symbol. No runtime override — env-only. |

Runtime-overridable knobs (`src/config/runtime-keys.js`) — changed from the dashboard Settings
page, take effect on the executor's next poll:

| Runtime key | Overrides | Label shown in dashboard |
| --- | --- | --- |
| `trading_enabled` | `LEGION_TRADING_ENABLED` | "Paper trading (kill switch)" |
| `trading_dry_run` | `LEGION_TRADING_DRY_RUN` | "Trading dry-run (log only)" |
| `trading_min_order_notional` | `LEGION_TRADING_MIN_NOTIONAL` | "Min order notional (USD)" |
