import { Router } from 'express';

// Live marks / freshness refresh ~ client poll cadence.
const CacheTtlMs = 30 * 1000;
// Candle depth for the equity curve — enough history to cover the trading window.
const FetchDays = 400;

// Buckets ascending-by-ts snapshots to the LAST snapshot per calendar day.
// Map#set on an existing key overwrites the value but keeps the key's original
// insertion position, so iteration order stays chronological.
function bucketDaily(snapshots) {
  const byDay = new Map();
  for (const snap of snapshots) {
    const date = new Date(snap.ts).toISOString().slice(0, 10);
    byDay.set(date, snap);
  }
  return [...byDay.entries()].map(([date, snap]) => ({ date, equity: snap.equity, cash: snap.cash }));
}

function sortByDate(candles) {
  return [...candles].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Last known close on or before `date` — candles are trading days only, so a
// snapshot taken on a weekend/holiday carries forward the prior close.
function closeOnOrBefore(sortedCandles, date) {
  let result = null;
  for (const c of sortedCandles) {
    if (c.date > date) break;
    result = c.close;
  }
  return result;
}

// Normalizes SPY/QQQ closes to the first bucketed point's equity, so the
// benchmark series starts co-located with the equity curve on the chart.
function buildCurve(dailyPoints, spySorted, qqqSorted) {
  if (dailyPoints.length === 0) return [];
  const firstEquity = dailyPoints[0].equity;
  const spyBase = closeOnOrBefore(spySorted, dailyPoints[0].date);
  const qqqBase = closeOnOrBefore(qqqSorted, dailyPoints[0].date);
  return dailyPoints.map((pt) => {
    const spyClose = closeOnOrBefore(spySorted, pt.date);
    const qqqClose = closeOnOrBefore(qqqSorted, pt.date);
    return {
      date: pt.date,
      equity: pt.equity,
      spy: spyBase && spyClose ? (firstEquity * spyClose) / spyBase : null,
      qqq: qqqBase && qqqClose ? (firstEquity * qqqClose) / qqqBase : null,
    };
  });
}

function computeReturns(dailyPoints, spySorted, qqqSorted) {
  if (dailyPoints.length === 0) return { totalReturn: null, spyReturn: null, qqqReturn: null };
  const first = dailyPoints[0];
  const last = dailyPoints.at(-1);
  const spyBase = closeOnOrBefore(spySorted, first.date);
  const spyLast = closeOnOrBefore(spySorted, last.date);
  const qqqBase = closeOnOrBefore(qqqSorted, first.date);
  const qqqLast = closeOnOrBefore(qqqSorted, last.date);
  return {
    totalReturn: last.equity / first.equity - 1,
    spyReturn: spyBase && spyLast ? spyLast / spyBase - 1 : null,
    qqqReturn: qqqBase && qqqLast ? qqqLast / qqqBase - 1 : null,
  };
}

// Marks broker positions to the live price; a missing/failed quote falls back
// to the position's own avgCost (a flat mark, not a crash — this is a display
// route, not an execution path).
async function markPositions(positions, gunvest) {
  return Promise.all(positions.map(async (p) => {
    const quote = gunvest ? await gunvest.getPrice(p.symbol).catch(() => null) : null;
    const markPrice = quote?.price ?? p.avgCost;
    const unrealizedPnl = (markPrice - p.avgCost) * p.qty;
    return {
      symbol: p.symbol,
      qty: p.qty,
      avgCost: p.avgCost,
      markPrice,
      marketValue: p.qty * markPrice,
      unrealizedPnl,
      unrealizedPnlPct: p.avgCost ? (markPrice - p.avgCost) / p.avgCost : 0,
    };
  }));
}

function mapOrder(intent) {
  return {
    id: intent.id,
    createdAt: intent.createdAt,
    symbol: intent.symbol,
    band: intent.band,
    conviction: intent.conviction,
    targetWeight: intent.targetWeight,
    status: intent.status,
    skipReason: intent.skipReason,
    submittedQty: intent.submittedQty,
    fillQty: intent.fillQty,
    fillPrice: intent.fillPrice,
    error: intent.error,
  };
}

const NullStats = { equity: null, cash: null, totalReturn: null, spyReturn: null, qqqReturn: null };

// Global (instance-level) IBKR-backed book — one paper account for the whole
// deployment, not per user (ADR 0035). Gateway health only gates the live
// positions/stats: the curve (DB equity snapshots) and orders (DB intent
// history) keep serving through a gateway blip so history never disappears.
export function portfolioRoutes(repo, gunvest, broker) {
  const router = Router();
  let cache = null; // single instance-wide entry: { at, key, payload }

  router.get('/', async (req, res, next) => {
    try {
      // Cheap freshness reads happen every request — they drive the cache key.
      const [snapshots, intents] = await Promise.all([
        repo.listEquitySnapshots(),
        repo.listOrderIntents(100),
      ]);
      const key = `${intents.length}:${snapshots.length}`;
      if (cache && cache.key === key && Date.now() - cache.at < CacheTtlMs) return res.json(cache.payload);

      const dailyPoints = bucketDaily(snapshots);
      // Benchmark candles; a fetch failure degrades to an unbenchmarked curve
      // rather than failing the whole request.
      const [spy, qqq] = gunvest
        ? await Promise.all([
          gunvest.getCandles('SPY', FetchDays).catch(() => []),
          gunvest.getCandles('QQQ', FetchDays).catch(() => []),
        ])
        : [[], []];
      const spySorted = sortByDate(spy);
      const qqqSorted = sortByDate(qqq);
      const curve = buildCurve(dailyPoints, spySorted, qqqSorted);

      let authenticated = false;
      let accountId = null;
      let positions = [];
      let stats = NullStats;

      if (broker) {
        try {
          if (await broker.isAuthenticated()) {
            const [rawPositions, summary] = await Promise.all([
              broker.getPositions(),
              broker.getAccountSummary(),
            ]);
            authenticated = true;
            accountId = summary.accountId;
            positions = await markPositions(rawPositions, gunvest);
            stats = { equity: summary.equity, cash: summary.cash, ...computeReturns(dailyPoints, spySorted, qqqSorted) };
          }
        } catch (err) {
          // Gateway blip: keep the request at 200 with degraded live data —
          // curve/orders (DB-backed) are unaffected.
          console.warn(`[portfolio] broker read failed: ${err.message}`);
        }
      }

      const payload = {
        gateway: { configured: !!broker, authenticated, accountId },
        stats,
        curve,
        positions,
        orders: intents.map(mapOrder),
      };
      cache = { at: Date.now(), key, payload };
      res.json(payload);
    } catch (err) { next(err); }
  });

  return router;
}
