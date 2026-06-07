import { agentInfo } from '../lib/agents.js';
import { AgentAvatar } from '../ui/AgentAvatar.jsx';
import { Badge } from '../ui/Badge.jsx';
import { InfoTip } from './InfoTip.jsx';
import { pct, stanceLabel, signedDelta } from '../lib/format.js';
import { threadModel } from '../lib/debate.js';

function DeltaPill({ delta }) {
  if (!delta) return null; // null or 0 -> no movement worth showing
  const up = delta > 0;
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
        up ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
      }`}
    >
      {up ? '▲' : '▼'} <span>{signedDelta(delta)}</span>
    </span>
  );
}

function Message({ msg }) {
  const { label } = agentInfo(msg.agentId);
  return (
    <div className="flex gap-3">
      <AgentAvatar agentId={msg.agentId} />
      <div className="min-w-0 flex-1 rounded-xl rounded-tl-sm border border-slate-200 bg-slate-50 p-3">
        {msg.peers.length > 0 && (
          <div className="mb-1 border-l-2 border-slate-300 pl-2 text-xs text-slate-400">
            re: {msg.peers.join(', ')}
          </div>
        )}
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-900">{label}</span>
          <Badge band={stanceLabel(msg.stance)}>{stanceLabel(msg.stance)}</Badge>
          <span className="text-xs text-slate-500">conv {pct(msg.conviction)}</span>
          <DeltaPill delta={msg.delta} />
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
          {msg.rationale}
        </p>
      </div>
    </div>
  );
}

export function DebateThread({ rounds }) {
  const model = threadModel(rounds);
  return (
    <div className="space-y-6">
      {model.map((round) => (
        <div key={round.roundNo}>
          <div className="mb-3 flex items-center gap-3">
            <span className="text-sm font-semibold text-slate-700">Round {round.roundNo}</span>
            <span className={round.converged ? 'text-xs text-green-600' : 'text-xs text-amber-600'}>
              {round.converged ? 'converged' : 'unconverged'}
            </span>
            <span className="ml-auto flex items-center gap-3 text-xs text-slate-400">
              <span className="inline-flex items-center">
                S {Number(round.sScore).toFixed(2)}
                <InfoTip label="S (aggregate stance)" title="S — aggregate stance">
                  Conviction-weighted mean stance, Σ(W·c·s) / Σ(W·c).
                </InfoTip>
              </span>
              <span className="inline-flex items-center">
                V {Number(round.dispersion).toFixed(2)}
                <InfoTip label="V (dispersion)" title="V — dispersion">
                  Weighted variance of stances around S. Lower means agents agree.
                </InfoTip>
              </span>
              <span className="inline-flex items-center">
                κ {Number(round.quorum).toFixed(2)}
                <InfoTip label="κ (quorum)" title="κ — directional quorum">
                  Weighted fraction of votes agreeing with the aggregate side.
                </InfoTip>
              </span>
            </span>
          </div>
          <div className="space-y-3">
            {round.messages.map((m) => (
              <Message key={m.agentId} msg={m} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
