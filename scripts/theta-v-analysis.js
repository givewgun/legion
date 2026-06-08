// Throwaway analysis: is θ_v=0.5 the binding gate, and does high V hurt outcomes?
// Run: node scripts/theta-v-analysis.js   (uses DATABASE_URL or the local default)
// Not committed — delete when done.
import { connectDb } from '../src/db/client.js';

const QUORUM = Number(process.env.CONSENSUS_QUORUM || 0.6667); // threshold κ must clear
const THETA_CANDIDATES = [0.3, 0.4, 0.5, 0.6, 0.75, 1.0, 1.25, 1.5, 2.0];

const url = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/gunvest';
const db = connectDb(url);

function pct(n, d) {
  return d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`;
}

async function main() {
  // ── How much history is there at all? ──────────────────────────────────────
  const counts = await db.queryOne(`
    SELECT
      (SELECT count(*) FROM legion.cycles)  AS cycles,
      (SELECT count(*) FROM legion.rounds)  AS rounds,
      (SELECT count(*) FROM legion.signals) AS signals,
      (SELECT count(*) FROM legion.signals WHERE resolved) AS resolved
  `);
  console.log('\n=== history ===');
  console.log(counts);
  if (Number(counts.rounds) === 0) {
    console.log('\nNO ROUND DATA. Cannot tune from history — simulate instead.');
    return;
  }

  // ── V distribution over the FINAL round of every cycle (the best attempt) ───
  const finals = await db.query(`
    SELECT DISTINCT ON (r.cycle_id)
      r.cycle_id, r.dispersion AS v, r.quorum AS kappa, r.converged, c.status
    FROM legion.rounds r
    JOIN legion.cycles c ON c.id = r.cycle_id
    ORDER BY r.cycle_id, r.round_no DESC
  `);
  const V = finals.map((r) => Number(r.v)).sort((a, b) => a - b);
  const quantile = (q) => V[Math.min(V.length - 1, Math.floor(q * V.length))];
  console.log('\n=== final-round V distribution (n=' + V.length + ') ===');
  console.log({
    min: V[0]?.toFixed(3),
    p25: quantile(0.25)?.toFixed(3),
    median: quantile(0.5)?.toFixed(3),
    p60: quantile(0.6)?.toFixed(3),
    p75: quantile(0.75)?.toFixed(3),
    p90: quantile(0.9)?.toFixed(3),
    max: V[V.length - 1]?.toFixed(3),
  });

  // ── Is θ_v the BINDING gate? Among finals where κ already clears quorum,    ──
  // ── how many are blocked only by V at each candidate θ_v?                   ──
  const kappaPass = finals.filter((r) => Number(r.kappa) >= QUORUM);
  console.log(
    `\n=== counterfactual convergence (κ≥${QUORUM} satisfied in ${kappaPass.length}/${finals.length} finals) ===`,
  );
  console.log('θ_v  | converge (κ&V both pass) | unlocked vs θ=0.5');
  const baseAt = (theta) => kappaPass.filter((r) => Number(r.v) <= theta).length;
  const base05 = baseAt(0.5);
  for (const theta of THETA_CANDIDATES) {
    const n = baseAt(theta);
    console.log(
      `${theta.toFixed(2).padStart(4)} | ${String(n).padStart(3)} / ${finals.length}  (${pct(n, finals.length)})`.padEnd(
        40,
      ) + ` | +${n - base05}`,
    );
  }

  // ── Does high V predict worse outcomes? Join converged round → signal. ──────
  const outcomes = await db.query(`
    SELECT r.dispersion AS v, s.correct,
           s.forward_return AS fwd, s.spy_return AS spy
    FROM legion.signals s
    JOIN legion.rounds r ON r.cycle_id = s.cycle_id AND r.converged = true
    WHERE s.resolved = true AND s.forward_return IS NOT NULL
  `);
  console.log('\n=== V vs outcome (resolved signals, n=' + outcomes.length + ') ===');
  if (outcomes.length === 0) {
    console.log('No resolved signals yet — outcome-vs-V link not measurable. Tune on distribution only for now.');
  } else {
    const buckets = [
      [0, 0.25],
      [0.25, 0.5],
      [0.5, 0.75],
      [0.75, 1.0],
      [1.0, 99],
    ];
    console.log('V range      | n  | hit-rate | mean excess (fwd−spy)');
    for (const [lo, hi] of buckets) {
      const b = outcomes.filter((o) => Number(o.v) >= lo && Number(o.v) < hi);
      if (b.length === 0) continue;
      const hits = b.filter((o) => o.correct).length;
      const exc = b.reduce((s, o) => s + (Number(o.fwd) - Number(o.spy)), 0) / b.length;
      console.log(
        `[${lo}, ${hi === 99 ? '∞' : hi})`.padEnd(12) +
          ` | ${String(b.length).padStart(2)} | ${pct(hits, b.length).padStart(7)} | ${(exc * 100).toFixed(2)}%`,
      );
    }
  }
}

main()
  .catch((e) => {
    console.error('\nQUERY FAILED:', e.message);
    console.error('If connection refused / db missing → no prod history. Pivot to simulation.');
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
