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

      <LearnSection index={1} title="The big idea">
        <p>
          Instead of asking <strong>one</strong> model whether to buy a stock, Legion puts{' '}
          <strong>four specialists</strong> in a room — a chart reader (technical), a news hound
          (news), a mood watcher (social), and a professional skeptic (contrarian). Each privately
          votes, then they argue it out. Three things make it more than averaging opinions:
        </p>
        <ul className="ml-4 mt-1 list-disc space-y-1">
          <li>
            <strong>Nobody is the boss.</strong> Everyone runs the same arithmetic on the same
            votes, so the answer is identical no matter who computes it. The agreement <em>is</em>{' '}
            the decision.
          </li>
          <li>
            <strong>Trust is earned.</strong> Each specialist has a track record; one who&apos;s
            been right gets a louder voice, one who&apos;s been wrong gets quieter.
          </li>
          <li>
            <strong>It never pulls the trigger.</strong> Legion only advises. A separate risk
            manager can tell it to calm down, but can never make it buy what the panel didn&apos;t
            want.
          </li>
        </ul>
        <p className="mt-2">
          The name is from the geth &ldquo;Legion&rdquo; in <em>Mass Effect</em>: a single body
          running thousands of small programs that vote, with no central mind.
        </p>
      </LearnSection>

      <LearnSection index={2} title="The debate">
        <p>
          For each ticker, Legion runs a cycle (every 4 hours, or on demand) with the four agents.
          Each vote is two numbers and a sentence: a <em>stance</em> from −2 (strong sell) to +2
          (strong buy), a <em>conviction</em> (0–1), and a <em>rationale</em>. Stance is a small
          ordinal scale, so &ldquo;how far apart two agents are&rdquo; is just subtraction.
        </p>
        <p className="mt-2">
          Each agent is its own process talking only over a message bus — no shared memory, no
          coordinator, so any agent can crash and restart without anyone else caring. That&apos;s
          what &ldquo;leaderless&rdquo; buys in practice.
        </p>
      </LearnSection>

      <LearnSection index={3} title="Convergence (S, V, κ)">
        <p>
          Each vote&apos;s influence is <strong>trust × confidence</strong> — its domain prior times
          a learned reliability, times its (calibrated) conviction. From those weighted votes each
          round is scored with three numbers:
        </p>
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
        <p className="mt-2">
          The default quorum is <strong>2/3</strong> — a Byzantine-style supermajority, so a single
          outlier can neither force a decision nor block one. Requiring low V too means a bare
          majority that&apos;s still <em>loudly</em> fighting is refused: that&apos;s a brawl, not a
          decision. Convergence does <em>not</em> require unanimity — a low-conviction dissenter can
          stay on the other side and the round still calls.
        </p>
      </LearnSection>

      <LearnSection index={4} title="Iteration &amp; dissent">
        <p>
          When the room doesn&apos;t agree, Legion doesn&apos;t average-and-shrug. It hands each
          specialist the <strong>strongest objections from the other side</strong> and asks
          &ldquo;knowing this, do you want to change your vote?&rdquo; Agents update — maybe the
          chart reader didn&apos;t know about the earnings the news hound saw. This repeats up to{' '}
          <strong>3 rounds</strong>. If they still can&apos;t agree, Legion emits{' '}
          <strong>NO_CONSENSUS</strong> — an honest shrug beats a forced trade.
        </p>
      </LearnSection>

      <LearnSection index={5} title="Three honesty guards">
        <p>Plain weighted voting is gameable, so three mechanisms keep agreement honest:</p>
        <ul className="ml-4 mt-1 list-disc space-y-1">
          <li>
            <strong>Redundancy discount</strong> — agents that historically move together count as
            fewer independent confirmations. Echoes aren&apos;t extra evidence.
          </li>
          <li>
            <strong>Anti-herding</strong> — a late agreement is only accepted if it had real
            independent backing in round 1. Everyone caving to the loudest voice is thrown out.
          </li>
          <li>
            <strong>Calibration</strong> — an agent that&apos;s confidently-but-usually-wrong has its
            confidence quietly turned down.
          </li>
        </ul>
        <p className="mt-2">
          All three are <em>off by default</em> (cold-start neutral) and only switch on once the
          system has enough resolved history.
        </p>
      </LearnSection>

      <LearnSection index={6} title="The risk manager">
        <p>
          A safety officer stands outside the voting room. He never votes on direction, but after
          the panel decides he can <strong>shrink</strong> a trade or <strong>veto a new buy</strong>{' '}
          — never flip a SELL into a BUY. Deterministic, no LLM: it reads VIX, the day&apos;s move,
          and the name&apos;s own volatility, and caps conviction or blocks new longs. The panel
          decides <em>what</em>; risk only limits <em>how much</em>.
        </p>
      </LearnSection>

      <LearnSection index={7} title="From score to signal">
        <p>
          On convergence the leaning number S becomes a human label and a conviction: |S| &lt; 0.5 →
          HOLD, |S| ≥ 1.5 → STRONG_BUY / STRONG_SELL, else BUY / SELL, with conviction =
          min(|S| / 2, 1). The signal carries the trade plan, every agent&apos;s rationale, and the
          S / V / κ so the dashboard can replay the whole debate.
        </p>
      </LearnSection>

      <LearnSection index={8} title="Backtesting">
        <p>
          Alongside the live debate, a plain no-AI strategy runs over historical prices (SMA, RSI,
          MACD rules only) as a fast, deterministic yardstick. Legion measures the{' '}
          <strong>hit rate</strong> (how often the call was right over the horizon) and{' '}
          <strong>PnL</strong>, always compared to holding <strong>SPY</strong> and{' '}
          <strong>QQQ</strong> over the same window — so a signal has to beat the benchmark, not just
          go up.
        </p>
      </LearnSection>

      <LearnSection index={9} title="Self-learning">
        <p>
          When a signal fires, Legion snapshots the entry price of the stock <em>and</em> of SPY at
          that instant, waits the fixed horizon, then asks the real question: <strong>did it beat
          the market?</strong> A BUY that rose 1% while the S&amp;P rose 3% was a <em>bad</em>{' '}
          relative call.
        </p>
        <p className="mt-2">
          That outcome grades each agent&apos;s vote (via a Brier score): confident-and-right raises
          its <strong>reliability ρ</strong>; confident-and-wrong lowers it faster (a confident wrong
          call is the expensive one). ρ re-weights how much the vote counts next time. The loop
          closes — the gestalt literally learns which voices to believe, and improves over time.
        </p>
      </LearnSection>
    </div>
  );
}
