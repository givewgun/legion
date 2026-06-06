import { pct, stanceLabel } from '../lib/format.js';

// Grid columns keep agent/stance/conviction aligned; the rationale cell carries
// min-w-0 so `truncate` actually engages and the row never overflows the card.
export function VoteRow({ vote }) {
  return (
    <div className="grid grid-cols-[7rem_5rem_4rem_1fr] items-center gap-2 border-b border-slate-100 py-1 text-sm">
      <span className="truncate font-medium">{vote.agent_id}</span>
      <span>{stanceLabel(vote.stance)}</span>
      <span className="text-slate-500">conv {pct(vote.conviction)}</span>
      <span className="min-w-0 truncate text-slate-400" title={vote.rationale}>
        {vote.rationale}
      </span>
    </div>
  );
}
