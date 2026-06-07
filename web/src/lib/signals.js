const BULL = new Set(['BUY', 'STRONG_BUY']);
const BEAR = new Set(['SELL', 'STRONG_SELL']);

export function summarize(rows) {
  if (!rows || rows.length === 0) {
    return { total: 0, bull: 0, bear: 0, avgConviction: 0, lastCreatedAt: null };
  }
  let bull = 0;
  let bear = 0;
  let convSum = 0;
  let last = null;
  for (const r of rows) {
    if (BULL.has(r.band)) bull += 1;
    if (BEAR.has(r.band)) bear += 1;
    convSum += r.conviction ?? 0;
    if (!last || (r.created_at && r.created_at > last)) last = r.created_at ?? last;
  }
  return {
    total: rows.length,
    bull,
    bear,
    avgConviction: convSum / rows.length,
    lastCreatedAt: last,
  };
}

// Returns a new sorted array. dir is 'asc' | 'desc'. Strings compare
// case-insensitively; everything else compares numerically.
export function sortSignals(rows, key, dir = 'desc') {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv)) * factor;
    }
    return ((av ?? 0) - (bv ?? 0)) * factor;
  });
}
