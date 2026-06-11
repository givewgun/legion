# Decisions

- **2026-06-11 — Market-aware cron cadence (ADR 0029).** The 4h/24-7 sweep cron was
  judged too granular: agents read daily candles, so most fires re-evaluated an unchanged
  bar and the overlapping 5-day signals corrupted reliability stats. New defaults:
  `LEGION_CRON=0 11,17 * * 1-5` and `LEGION_SUMMARY_CRON=0 18 * * 1-5` (24h window),
  evaluated in `LEGION_CRON_TZ=America/New_York` via node-cron's `timezone` option —
  explicitly NOT the container TZ, because prod runs `TZ=Asia/Bangkok` where Friday's US
  post-close falls on Saturday ICT. Full rationale: `docs/adr/0029-market-aware-cron.md`.
