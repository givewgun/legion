// Complete class strings per band so Tailwind keeps them.
const BAND_CLASSES = {
  STRONG_BUY: 'bg-green-100 text-green-700',
  BUY: 'bg-green-100 text-green-700',
  HOLD: 'bg-slate-100 text-slate-600',
  SELL: 'bg-red-100 text-red-700',
  STRONG_SELL: 'bg-red-100 text-red-700',
};

export function Badge({ band, children, className = '' }) {
  const cls = BAND_CLASSES[band] ?? BAND_CLASSES.HOLD;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${cls} ${className}`}
    >
      {children ?? band}
    </span>
  );
}
