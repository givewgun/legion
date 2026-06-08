// Forward paper-test resolver: turns due signals into realized forward/benchmark
// returns and a binary alpha outcome (beat SPY?). Pure returnOver + I/O resolveSignals.
//
// The holding window is pinned to the signal's fixed horizon — [created_at, resolve_after],
// where resolve_after = created_at + horizonDays (set at emit time) — NOT to the cron fire
// time. Scoring to "now" let a late-running resolver stretch the window, so two signals with
// the same horizon could be scored over different elapsed times and their Brier scores were
// not comparable. Pinning to resolve_after makes resolution deterministic and horizon-faithful.
const HORIZON_FETCH_DAYS = 90; // candle history wide enough to span any open holding window

function day(ts) {
  return String(ts).slice(0, 10);
}

export function returnOver(candles, fromTs, toTs) {
  const from = day(fromTs);
  const to = day(toTs);
  const within = candles.filter((c) => c.date >= from && c.date <= to);
  if (within.length < 2) return null;
  const c0 = within[0].close;
  const c1 = within[within.length - 1].close;
  if (!c0) return null;
  return (c1 - c0) / c0;
}

export async function resolveSignals(repo, gunvest, now) {
  const due = await repo.listUnresolvedSignals(now);
  let resolved = 0;
  for (const sig of due) {
    const [stock, spy, qqq] = await Promise.all([
      gunvest.getCandles(sig.symbol, HORIZON_FETCH_DAYS),
      gunvest.getCandles('SPY', HORIZON_FETCH_DAYS),
      gunvest.getCandles('QQQ', HORIZON_FETCH_DAYS),
    ]);
    const windowEnd = sig.resolve_after;
    const forwardReturn = returnOver(stock, sig.created_at, windowEnd);
    const spyReturn = returnOver(spy, sig.created_at, windowEnd);
    const qqqReturn = returnOver(qqq, sig.created_at, windowEnd);
    if (forwardReturn == null || spyReturn == null) continue;

    const outcome = forwardReturn > spyReturn ? 1 : 0;
    const stance = await repo.getSignalStance(sig.id);
    const excess = forwardReturn - spyReturn;
    let correct = null;
    if (stance > 0) correct = excess > 0;
    else if (stance < 0) correct = excess < 0;

    await repo.resolveSignal(sig.id, {
      forwardReturn,
      spyReturn,
      qqqReturn: qqqReturn ?? null,
      outcome,
      correct,
    });
    resolved += 1;
  }
  return resolved;
}
