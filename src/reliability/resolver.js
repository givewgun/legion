// Forward paper-test resolver: turns due signals into realized forward/benchmark
// returns and a binary alpha outcome (beat SPY?). Pure return helpers + I/O resolveSignals.
//
// Each leg is measured from the price captured at signal-fire time (the stock's
// entry_price plus the SPY/QQQ entry prices snapshotted in the same instant) to the
// horizon-end close — a faithful "entered everything when the signal fired" test.
// Signals predating benchmark-entry capture fall back to a close-to-close window.
//
// The holding window is pinned to the signal's fixed horizon — [created_at, resolve_after],
// where resolve_after = created_at + horizonDays (set at emit time) — NOT to the cron fire
// time. Scoring to "now" let a late-running resolver stretch the window, so two signals with
// the same horizon could be scored over different elapsed times and their Brier scores were
// not comparable. Pinning to resolve_after makes resolution deterministic and horizon-faithful.
const HORIZON_FETCH_DAYS = 90; // candle history wide enough to span any open holding window

// Normalize to a YYYY-MM-DD (UTC) day key. Accepts both ISO strings and the JS
// Date objects node-postgres returns for TIMESTAMPTZ columns (created_at,
// resolve_after) — String(Date) yields "Mon Jun 08 …", which would match no
// candle rows and silently skip every due signal.
function day(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// Close-to-close return over [from, to]. The legacy base, kept as the fallback
// for signals emitted before benchmark entry prices were captured and for cycles
// where the live entry-price fetch failed at emit time.
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

// Last candle close on or before `toTs` (candles are ascending by date) — the
// horizon-end exit used by the live-entry paper-test.
export function closeOnOrBefore(candles, toTs) {
  const to = day(toTs);
  const within = candles.filter((c) => c.date <= to);
  if (within.length === 0) return null;
  return within[within.length - 1].close;
}

// Return from the price captured at signal-fire time (entry_price) to the
// horizon-end close. This is the honest base: the stock and its benchmarks all
// "enter" at the same instant the signal fired, immune to candle lag and to the
// intraday/daily-close mismatch of measuring from the signal day's close.
export function returnFromEntry(candles, entryPrice, toTs) {
  if (!entryPrice) return null;
  const exit = closeOnOrBefore(candles, toTs);
  if (exit == null) return null;
  return (exit - entryPrice) / entryPrice;
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

    // Live-entry paper-test: measure each leg from the price captured at signal
    // fire time to the horizon-end close, so the stock and its benchmarks share
    // the same "entered at signal time" convention and the comparison is fair.
    // Legacy signals (and cycles where the entry fetch failed) lack benchmark
    // entry prices — fall back to a consistent close-to-close window for those.
    const liveEntry = sig.entry_price != null && sig.spy_entry_price != null;
    let forwardReturn, spyReturn, qqqReturn;
    if (liveEntry) {
      forwardReturn = returnFromEntry(stock, sig.entry_price, windowEnd);
      spyReturn = returnFromEntry(spy, sig.spy_entry_price, windowEnd);
      qqqReturn =
        sig.qqq_entry_price != null ? returnFromEntry(qqq, sig.qqq_entry_price, windowEnd) : null;
    } else {
      forwardReturn = returnOver(stock, sig.created_at, windowEnd);
      spyReturn = returnOver(spy, sig.created_at, windowEnd);
      qqqReturn = returnOver(qqq, sig.created_at, windowEnd);
    }
    if (forwardReturn == null || spyReturn == null) continue;

    // SPY is the single scoring benchmark (ADR 0008): only spyReturn drives
    // `outcome` and the Brier loop. qqqReturn is captured and stored for the
    // dashboard only — it never feeds the learning signal.
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
