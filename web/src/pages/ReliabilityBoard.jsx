import { useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  ReferenceLine,
} from 'recharts';
import { api } from '../api/client.js';
import { agentInfo } from '../lib/agents.js';
import { stanceLabel } from '../lib/format.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';
import { InfoTip } from '../components/InfoTip.jsx';

// Render a fraction (e.g. 0.018) as a signed percentage string, or "—" for null.
function fmtAlpha(v) {
  if (v == null) return '—';
  const pct = (v * 100).toFixed(1);
  return v >= 0 ? `+${pct}%` : `${pct}%`;
}

// Render hitRate (0–1 fraction) as "X.X%" or "—" for null.
function fmtHitRate(v) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

// Map win (bool|null) → Badge band and label.
function winBand(win) {
  if (win === true) return { band: 'BUY', label: 'Win' };
  if (win === false) return { band: 'SELL', label: 'Loss' };
  return { band: 'HOLD', label: 'Hold' };
}

// Collapsible "How to read this board" panel.
function HowToRead() {
  const [open, setOpen] = useState(false);
  return (
    <Card className="mb-5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
        aria-expanded={open}
        data-testid="how-to-read-toggle"
      >
        <span>How to read this board</span>
        <span className="text-slate-400">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div
          className="border-t border-slate-100 px-4 py-3 text-sm text-slate-600 space-y-2"
          data-testid="how-to-read-content"
        >
          <p>
            <strong>ρ (rho)</strong> measures skill relative to a coin-flip baseline. The baseline
            is <strong>1.0</strong> — at exactly 1.0 the agent performs like random chance; above
            baseline 1.0 it beats the coin-flip, below it underperforms. The chart is centered at
            1.0 so you can immediately see who adds edge.
          </p>
          <p>
            <strong>Rolling 50-call window</strong>: all stats (wins, losses, hit rate, alpha,
            sample) are computed over each agent's <em>newest 50 resolved calls</em>, not their
            entire history. "Sample" caps at 50 because only the most recent signal matters for
            re-weighting; older calls age out.
          </p>
          <p>
            <strong>Calibration</strong> measures whether stated conviction levels match actual
            outcomes — a well-calibrated agent that says "80% confident" is right roughly 80% of
            the time.
          </p>
          <p>
            <strong>Info factor</strong> captures how much unique information an agent provides
            beyond what the consensus already knows.
          </p>
          <p>
            <strong>These dials re-weight each agent's future votes</strong> in the debate engine.
            Agents with higher ρ, better calibration, and higher info factor carry more weight in
            the next consensus round.
          </p>
        </div>
      )}
    </Card>
  );
}

// Expandable row detail showing recent calls.
function RecentCallsDetail({ recent }) {
  if (!recent || recent.length === 0) {
    return (
      <tr>
        <td colSpan={8} className="px-6 py-2 text-xs text-slate-400">
          No recent resolved calls.
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td colSpan={8} className="px-6 py-3 bg-slate-50 border-b border-slate-100">
        <div className="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">
          Recent calls
        </div>
        <table className="w-full text-xs text-left" data-testid="recent-calls-table">
          <thead>
            <tr className="text-slate-400">
              <th className="pr-4 pb-1 font-medium">Symbol</th>
              <th className="pr-4 pb-1 font-medium">Stance</th>
              <th className="pr-4 pb-1 font-medium">Conviction</th>
              <th className="pr-4 pb-1 font-medium">Result</th>
              <th className="pb-1 font-medium">Alpha</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((c, i) => {
              const { band, label } = winBand(c.win);
              return (
                <tr key={i} className="border-t border-slate-100">
                  <td className="pr-4 py-1 font-medium text-slate-800">{c.symbol}</td>
                  <td className="pr-4 py-1">
                    <Badge band={stanceLabel(c.stance)}>{stanceLabel(c.stance)}</Badge>
                  </td>
                  <td className="pr-4 py-1 text-slate-600">
                    {c.conviction != null ? `${(c.conviction * 100).toFixed(0)}%` : '—'}
                  </td>
                  <td className="pr-4 py-1">
                    <Badge band={band}>{label}</Badge>
                  </td>
                  <td className="py-1 text-slate-600">{fmtAlpha(c.alpha)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </td>
    </tr>
  );
}

// One table row + optional expanded detail.
function AgentRow({ r }) {
  const [expanded, setExpanded] = useState(false);
  const info = agentInfo(r.agentId);

  const avgAlphaStr =
    r.avgAlpha == null
      ? '—'
      : `${fmtAlpha(r.avgAlpha)}  (best ${fmtAlpha(r.bestAlpha)} / worst ${fmtAlpha(r.worstAlpha)})`;

  return (
    <>
      <tr
        className="border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50 select-none"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`agent-row-${r.agentId}`}
        aria-expanded={expanded}
      >
        <td className="px-4 py-2 font-medium text-slate-800">{info.label}</td>
        <td className="px-4 py-2 text-slate-700">
          {r.wins ?? 0}–{r.losses ?? 0}–{r.holds ?? 0}
        </td>
        <td className="px-4 py-2 text-slate-700">{fmtHitRate(r.hitRate)}</td>
        <td className="px-4 py-2 text-slate-600 text-xs whitespace-nowrap">{avgAlphaStr}</td>
        <td className="px-4 py-2 text-slate-700">{r.rho.toFixed(2)}</td>
        <td className="px-4 py-2 text-slate-700">{r.calibration.toFixed(2)}</td>
        <td className="px-4 py-2 text-slate-700">{r.infoFactor.toFixed(2)}</td>
        <td className="px-4 py-2 text-slate-500">{r.sampleSize}</td>
      </tr>
      {expanded && <RecentCallsDetail recent={r.recent} />}
    </>
  );
}

export function ReliabilityBoard() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getReliability()
      .then(setRows)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;
  if (rows && rows.length === 0) return <p className="text-slate-400">No reliability data yet.</p>;

  const data = (rows ?? []).map((r) => ({ ...r, label: agentInfo(r.agentId).label }));

  return (
    <div>
      <PageHeader
        title="Agent reliability"
        subtitle="ρ measures each agent's skill vs a coin-flip baseline (1.0 = baseline; higher is better)"
      />

      <HowToRead />

      <Card className="mb-5 p-3">
        <div className="h-56 w-full" data-testid="reliability-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ left: 24, right: 16 }}>
              <XAxis type="number" domain={[0.5, 1.5]} stroke="#94a3b8" fontSize={12} />
              <YAxis type="category" dataKey="label" stroke="#94a3b8" fontSize={12} width={80} />
              <Tooltip />
              <ReferenceLine x={1.0} stroke="#94a3b8" strokeDasharray="4 2" label="baseline" />
              <Bar dataKey="rho" radius={[0, 4, 4, 0]}>
                {data.map((r) => (
                  <Cell key={r.agentId} fill={agentInfo(r.agentId).hex} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="px-4 py-2 font-medium text-slate-500">Agent</th>
              <th className="px-4 py-2 font-medium text-slate-500">
                Record
                <InfoTip label="Record">
                  Wins – Losses – Holds over the rolling 50-call window. A "hold" stance (neutral)
                  counts as neither a win nor a loss.
                </InfoTip>
              </th>
              <th className="px-4 py-2 font-medium text-slate-500">
                Hit%
                <InfoTip label="Hit%">
                  Percentage of directional calls (non-hold) that were correct. Null when the agent
                  has made no directional calls yet.
                </InfoTip>
              </th>
              <th className="px-4 py-2 font-medium text-slate-500">
                Avg α
                <InfoTip label="Avg α">
                  Average alpha (agent return minus SPY return) per call, shown as a percentage.
                  Best and worst single-call alpha are shown in parentheses.
                </InfoTip>
              </th>
              <th className="px-4 py-2 font-medium text-slate-500">
                ρ
                <InfoTip label="ρ">
                  Skill score vs a coin-flip baseline. 1.0 = baseline; above 1.0 the agent beats
                  random chance. Computed over the rolling 50-call window.
                </InfoTip>
              </th>
              <th className="px-4 py-2 font-medium text-slate-500">
                Calibration
                <InfoTip label="Calibration">
                  How well stated conviction matches actual outcomes. A calibrated agent that says
                  "80% confident" is right about 80% of the time.
                </InfoTip>
              </th>
              <th className="px-4 py-2 font-medium text-slate-500">
                Info
                <InfoTip label="Info">
                  Information factor: how much unique signal this agent adds beyond the consensus.
                  Higher = more independent/valuable perspective.
                </InfoTip>
              </th>
              <th className="px-4 py-2 font-medium text-slate-500">
                Sample
                <InfoTip label="Sample">
                  Number of resolved calls in the rolling 50-call window. Caps at 50 — older calls
                  age out as new ones come in.
                </InfoTip>
              </th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <AgentRow key={r.agentId} r={r} />
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
