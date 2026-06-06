import { VoteRow } from './VoteRow.jsx';
import { InfoTip } from './InfoTip.jsx';

export function RoundCard({ round }) {
  return (
    <div className="mb-4 rounded-lg border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">Round {round.round_no}</h3>
        <span className={round.converged ? 'text-green-600' : 'text-amber-600'}>
          {round.converged ? 'converged' : 'unconverged'}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
        <span className="inline-flex items-center">
          S {Number(round.s_score).toFixed(2)}
          <InfoTip label="S (aggregate stance)" title="S — aggregate stance">
            Conviction-weighted mean of every agent&apos;s stance (−2 strong sell … +2 strong buy):
            Σ(W·c·s) / Σ(W·c). This is what maps to the BUY / HOLD / SELL band.
          </InfoTip>
        </span>
        <span className="inline-flex items-center">
          V {Number(round.dispersion).toFixed(2)}
          <InfoTip label="V (dispersion)" title="V — dispersion">
            Weighted variance of stances around S. High V means the agents disagree; a round can
            only converge once V drops to the threshold θ_v.
          </InfoTip>
        </span>
        <span className="inline-flex items-center">
          κ {Number(round.quorum).toFixed(2)}
          <InfoTip label="κ (quorum)" title="κ — directional quorum">
            Weighted fraction of votes whose side agrees with the aggregate. A round converges only
            when κ reaches the required quorum.
          </InfoTip>
        </span>
      </div>
      {round.votes.map((v) => (
        <VoteRow key={v.agent_id} vote={v} />
      ))}
    </div>
  );
}
