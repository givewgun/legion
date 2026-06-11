# Sessions

- **2026-06-11** — Assessed cron granularity, concluded the 4h/24-7 sweep was noise-heavy,
  and shipped ADR 0029: market-hours-anchored sweep + once-daily digest, timezone-pinned
  to America/New_York (prod containers run Asia/Bangkok). Updated scheduler/summary
  runners, config (+`cronTimezone`), deploy workflow, `.env.example`, docs, and config
  tests. Full suite green (527 tests).
