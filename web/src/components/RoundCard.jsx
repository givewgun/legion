import { VoteRow } from './VoteRow.jsx';

export function RoundCard({ round }) {
  return (
    <div className="mb-4 rounded-lg border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">Round {round.round_no}</h3>
        <span className={round.converged ? 'text-green-600' : 'text-amber-600'}>
          {round.converged ? 'converged' : 'unconverged'}
        </span>
      </div>
      <div className="mb-2 flex gap-4 text-xs text-slate-500">
        <span>S {Number(round.s_score).toFixed(2)}</span>
        <span>V {Number(round.dispersion).toFixed(2)}</span>
        <span>κ {Number(round.quorum).toFixed(2)}</span>
      </div>
      {round.votes.map((v) => (
        <VoteRow key={v.agent_id} vote={v} />
      ))}
    </div>
  );
}
