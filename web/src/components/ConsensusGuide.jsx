import { useState } from 'react';

// Collapsible plain-language explainer for the debate / consensus loop.
// Collapsed by default so it never crowds the data, but one click away.
export function ConsensusGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-slate-700"
      >
        <span>How consensus works</span>
        <span className="text-slate-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-slate-200 px-3 py-3 text-sm text-slate-600">
          <p>
            Each cycle runs four agents — <strong>technical</strong>, <strong>news</strong>,{' '}
            <strong>social</strong>, and <strong>contrarian</strong>. Every round, each agent casts
            a <em>stance</em> from −2 (strong sell) to +2 (strong buy) with a <em>conviction</em>{' '}
            (0–1). Agents read each other and revise over successive rounds until the round
            converges.
          </p>
          <p>Each round is summarised by three numbers:</p>
          <ul className="ml-4 list-disc space-y-1">
            <li>
              <strong>S — aggregate stance.</strong> Conviction-weighted mean of the stances,
              Σ(W·c·s) / Σ(W·c). Drives the final BUY / HOLD / SELL band.
            </li>
            <li>
              <strong>V — dispersion.</strong> Weighted variance of stances around S. Lower means
              the agents agree.
            </li>
            <li>
              <strong>κ — directional quorum.</strong> Weighted fraction of votes whose side agrees
              with the aggregate.
            </li>
          </ul>
          <p className="rounded bg-white px-2 py-1 font-mono text-xs text-slate-700">
            A round converges iff κ ≥ quorum AND V ≤ θ_v.
          </p>
        </div>
      )}
    </div>
  );
}
