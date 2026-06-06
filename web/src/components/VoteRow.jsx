import { pct, stanceLabel } from '../lib/format.js';

export function VoteRow({ vote }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-1 text-sm">
      <span className="font-medium">{vote.agent_id}</span>
      <span>{stanceLabel(vote.stance)}</span>
      <span className="text-slate-500">conv {pct(vote.conviction)}</span>
      <span className="max-w-[50%] truncate text-slate-400">{vote.rationale}</span>
    </div>
  );
}
