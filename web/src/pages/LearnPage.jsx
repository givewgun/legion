import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';
import { ConsensusPipeline } from '../components/ConsensusPipeline.jsx';
import { LearnSection } from '../components/LearnSection.jsx';

export function LearnPage() {
  return (
    <div>
      <PageHeader
        title="How Legion works"
        subtitle="Consensus debate, backtesting, and self-learning — end to end"
      />

      <Card className="mb-8 p-5">
        <ConsensusPipeline />
      </Card>

      <LearnSection index={1} title="The debate">
        <p>
          For each ticker, Legion runs a cycle with four specialist agents —{' '}
          <strong>technical</strong>, <strong>news</strong>, <strong>social</strong>, and{' '}
          <strong>contrarian</strong>. Every round, each agent casts a <em>stance</em> from −2
          (strong sell) to +2 (strong buy) with a <em>conviction</em> (0–1). From round two onward,
          each agent is shown the other agents&apos; prior votes and may revise its own.
        </p>
      </LearnSection>

      <LearnSection index={2} title="Convergence (S, V, κ)">
        <p>Each round is scored with three numbers:</p>
        <ul className="ml-4 mt-1 list-disc space-y-1">
          <li>
            <strong>S</strong> — conviction-weighted mean stance, Σ(W·c·s) / Σ(W·c). Drives the
            BUY/HOLD/SELL band.
          </li>
          <li>
            <strong>V</strong> — weighted dispersion of stances around S. Lower means the agents
            agree.
          </li>
          <li>
            <strong>κ</strong> — weighted fraction of votes whose side agrees with the aggregate.
          </li>
        </ul>
        <p className="mt-2 rounded bg-slate-50 px-2 py-1 font-mono text-xs text-slate-700">
          A round converges iff κ ≥ quorum AND V ≤ θ_v.
        </p>
      </LearnSection>

      <LearnSection index={3} title="Backtesting">
        <p>
          Converged signals are replayed against history. Legion measures the{' '}
          <strong>hit rate</strong> (how often the call was right over the horizon) and{' '}
          <strong>PnL</strong>, always compared to holding <strong>SPY</strong> and{' '}
          <strong>QQQ</strong> over the same window — so a signal has to beat the benchmark, not
          just go up.
        </p>
      </LearnSection>

      <LearnSection index={4} title="Self-learning">
        <p>
          When a signal resolves, each agent&apos;s past vote is scored against the real outcome.
          That updates the agent&apos;s <strong>reliability ρ</strong>, which re-weights how much
          its vote counts in future debates. Agents that are consistently right gain influence; the
          loop closes and the system improves over time.
        </p>
      </LearnSection>
    </div>
  );
}
