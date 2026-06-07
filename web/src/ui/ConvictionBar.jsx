const FILL = {
  STRONG_BUY: 'bg-green-600',
  BUY: 'bg-green-600',
  HOLD: 'bg-slate-400',
  SELL: 'bg-red-600',
  STRONG_SELL: 'bg-red-600',
};

export function ConvictionBar({ value, band = 'HOLD' }) {
  const widthPct = `${Math.round(Math.max(0, Math.min(1, value ?? 0)) * 100)}%`;
  return (
    <div className="h-1.5 w-full rounded-full bg-slate-200">
      <div
        data-testid="conviction-fill"
        className={`h-1.5 rounded-full ${FILL[band] ?? FILL.HOLD}`}
        style={{ width: widthPct }}
      />
    </div>
  );
}
