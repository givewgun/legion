# ADR 0029 — Market-Aware Sweep Cadence

## Status

Accepted (2026-06-11). Changes the `LEGION_CRON` default from `0 */4 * * *` (every 4h,
24/7) to `0 11,17 * * 1-5` evaluated in `LEGION_CRON_TZ` (default `America/New_York`),
and the digest from `0 */6 * * *` / 6h window to `0 18 * * 1-5` / 24h window.

## Context

The scheduler fired every 4 hours, around the clock, seven days a week — 42 sweeps per
week. But the cadence was disconnected from how often the system's inputs actually
change and how its outputs are judged:

- **Agents read daily candles.** The technical and contrarian agents consume
  `/api/market/:symbol/candles` rows keyed by `date` with one `close` per day. Between
  one market close and the next, every sweep re-evaluates the *same bar* — only the
  news/social feeds differ. Of the week's 168 hours, US equities trade ~32.5 (9:30–16:00
  ET, Mon–Fri), so roughly 80% of a 24/7 cron's fires ran against a market that could not
  produce new price information. Weekend sweeps were strictly worse: no new bars, *and*
  signals emitted then cannot even begin resolving until Monday.
- **Redundant sampling is noise, not signal.** The market-microstructure literature
  formalizes the intuition: when observations carry noise relative to the underlying
  process, the MSE-optimal sampling frequency is *finite* — sampling faster makes the
  estimate worse, not better ([Aït-Sahalia, Mykland & Zhang 2005, *How Often to Sample a
  Continuous-Time Process in the Presence of Market Microstructure Noise*, RFS
  18(2)](https://academic.oup.com/rfs/article/18/2/351/1599888)). Here the "noise" is an
  LLM re-reading an unchanged bar plus jittery intraday feeds and emitting a
  near-duplicate of its last signal.
- **Overlapping horizons corrupt the reliability loop.** Signals resolve after
  `horizonDays = 5`. Six signals/day per ticker means ~30 concurrently open signals per
  ticker whose 5-day outcomes share almost the same realized path. Since Hansen & Hodrick
  (1980) it is standard that observations sampled more often than the forecast horizon
  are serially correlated — the *nominal* sample inflates while the *effective* sample
  does not ([overview](https://www.federalreserve.gov/pubs/ifdp/2006/853/ifdp853.pdf)).
  Brier scores and ρ (ADR 0008) computed over such a window overweight whichever single
  market move 30 near-clones of one call happened to straddle.
- **Alert fatigue.** The 6h digest fired 28×/week regardless of content; with sweeps
  concentrated in market hours most windows render "No signals this window". The
  alarm-fatigue literature in safety-critical operations consistently finds that a high
  rate of uninformative alerts trains operators to ignore the channel — the opposite of
  what a conviction-ranked digest is for.

Production had already half-acknowledged this (`LEGION_CRON=0 20,22,2,4,8,15 * * 1-5` in
the deploy workflow — weekdays only), but still fired four of six daily sweeps between
close and the next open, against an identical candle.

There is also a timezone trap: node-cron evaluates expressions in the *process's* local
time, and the prod compose sets `TZ=Asia/Bangkok` (UTC+7, no DST) on every service. A
schedule reasoned in UTC or ET drifts when the container zone differs — and because the
US close lands at ~04:00–05:00 ICT *the next day*, a `1-5` day-of-week filter in Bangkok
time silently drops Friday's post-close moment (it is Saturday in ICT).

## Decision

Tie the cadence to information arrival, not the wall clock — and pin the clock to the
exchange, not the container:

- **Schedules are evaluated in `LEGION_CRON_TZ` (default `America/New_York`)**, passed as
  node-cron's `timezone` option. This makes the cadence immune to the container's `TZ`
  (prod: `Asia/Bangkok`), to DST (ET shifts against both UTC and ICT twice a year), and
  to the cross-midnight day-of-week skew above.
- **`LEGION_CRON=0 11,17 * * 1-5`** — two sweeps per US trading day:
  - **11:00 ET** — mid-session. Catches overnight + pre-market news (the inputs that
    *do* change between bars) with live macro/VIX, including anything that accrued over
    the weekend on Mondays.
  - **17:00 ET** — an hour after the 16:00 ET close, so the day's candle is final. This
    is the bar-complete evaluation.
- **`LEGION_SUMMARY_CRON=0 18 * * 1-5`** with **`LEGION_SUMMARY_WINDOW_HOURS=24`** — one
  digest per trading day, an hour after the post-close sweep, covering a full 24h so
  nothing falls between windows. Every digest now has both sweeps' output to rank. (For
  a Bangkok reader that is ~05:00–06:00 ICT — the day's digest is waiting at breakfast.)
- The deploy workflow drops its bespoke schedule and uses the same value.

Per ticker this cuts sweeps from 42 to 10 per week (−76%) and concurrently open 5-day
signals from ~30 to ~10, while keeping the two moments that carry distinct information:
fresh news intra-session, and the completed bar post-close. LLM spend falls
proportionally for free.

## Alternatives considered

- **Once per day (post-close only)** — maximally clean statistically, but forfeits the
  news/social agents' only edge: reacting intra-day to information the candle doesn't
  show yet. Two samples/day is the floor that still exercises all four specialists.
- **Keep 4h but dedupe/suppress unchanged signals downstream** — treats the symptom;
  the LLM cost, the redundant debates, and the overlapping-resolution skew all remain.
- **Match the signal horizon (one sweep per 5 days)** — eliminates overlap entirely, but
  the digest and dashboard go quiet for days and a mid-week regime break goes unseen
  until the next sweep. Daily-cadence overlap is acceptable; ρ's graded window (ADR 0017)
  already damps shared-path streaks.
- **Exchange-calendar awareness (holidays, half-days)** — correct but heavy; a cron
  firing on a NYSE holiday behaves like a weekend fire used to (no new bar, nothing
  resolves) ~9 days a year. Not worth a calendar dependency yet.

## Consequences

- Reliability ρ is now estimated on far less serially-correlated outcomes; expect it to
  move *slower* but mean more. Existing ρ values were computed under the old overlap and
  will gradually wash out of the graded window.
- Anything that breaks intra-day between 15:00 UTC and the close waits for the post-close
  sweep — `POST /api/trigger` and `npm run kick` remain the escape hatches.
- A signal emitted at the 17:00 ET sweep lands in that same evening's 18:00 ET digest;
  one emitted by a slow cycle after 18:00 appears in the next trading day's digest
  instead of being dropped. Because the digest skips weekends, Monday's run stretches its
  window to 72h (`effectiveWindowHours`) so anything landing after Friday's digest — a
  post-close cycle still finishing, a weekend manual kick — is summarized rather than
  falling between Friday 18:00 and Sunday 18:00.
- Operators wanting the old behaviour set `LEGION_CRON=0 */4 * * *` back in `.env` — the
  knob is unchanged, only its default moved. Anyone scheduling in another zone sets
  `LEGION_CRON_TZ`; expressions no longer follow the container's `TZ`.

## References

- Aït-Sahalia, Y., Mykland, P. A., & Zhang, L. (2005). *How Often to Sample a
  Continuous-Time Process in the Presence of Market Microstructure Noise.* Review of
  Financial Studies, 18(2), 351–416. <https://academic.oup.com/rfs/article/18/2/351/1599888>
- Hansen, L. P., & Hodrick, R. J. (1980). *Forward Exchange Rates as Optimal Predictors
  of Future Spot Rates: An Econometric Analysis.* Journal of Political Economy, 88(5) —
  the canonical treatment of overlapping-observation serial correlation; see also
  [Inference in Long-Horizon Regressions (Fed IFDP 853)](https://www.federalreserve.gov/pubs/ifdp/2006/853/ifdp853.pdf).
