// Historical co-movement of agents' votes, used to discount redundant agreement
// in the quorum (ADR 0015). Two agents whose stances have moved together in the
// past provide correlated — not independent — confirmation, so their agreement
// should count for less than that of genuinely independent voices.

// Common signals a pair must share before its correlation is trusted; below this
// the pair is treated as independent (correlation 0), like the cold-start ρ.
export const MIN_CORR_PAIRS = 5;

// Pearson correlation of two equal-length series. Returns null when undefined —
// fewer than two points, or zero variance in either series (e.g. an agent that
// always votes the same stance, whose co-movement cannot be established).
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / n;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

// rows: [{ signal_id, agent_id, stance }] across many signals. Returns
// [{ a, b, corr, n }] (a < b lexically) for every agent pair that co-rated at
// least `minPairs` signals with a defined correlation.
export function pairwiseCorrelations(rows, minPairs = MIN_CORR_PAIRS) {
  const bySignal = new Map();
  for (const r of rows) {
    if (!bySignal.has(r.signal_id)) bySignal.set(r.signal_id, {});
    bySignal.get(r.signal_id)[r.agent_id] = r.stance;
  }
  const series = new Map(); // "a|b" -> { a, b, xs, ys }
  for (const stances of bySignal.values()) {
    const agents = Object.keys(stances).sort();
    for (let i = 0; i < agents.length; i += 1) {
      for (let j = i + 1; j < agents.length; j += 1) {
        const a = agents[i];
        const b = agents[j];
        const key = `${a}|${b}`;
        if (!series.has(key)) series.set(key, { a, b, xs: [], ys: [] });
        const s = series.get(key);
        s.xs.push(stances[a]);
        s.ys.push(stances[b]);
      }
    }
  }
  const out = [];
  for (const { a, b, xs, ys } of series.values()) {
    if (xs.length < minPairs) continue;
    const corr = pearson(xs, ys);
    if (corr == null) continue;
    out.push({ a, b, corr, n: xs.length });
  }
  return out;
}
