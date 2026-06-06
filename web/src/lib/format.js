const STANCE_LABELS = {
  '-2': 'STRONG_SELL',
  '-1': 'SELL',
  0: 'HOLD',
  1: 'BUY',
  2: 'STRONG_BUY',
};

export function pct(x) {
  return `${Math.round((x ?? 0) * 100)}%`;
}

// Short local date for cycle/round timestamps. Returns '' for nullish input
// so callers can drop it without guarding.
export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function stanceLabel(stance) {
  return STANCE_LABELS[String(stance)] ?? 'HOLD';
}

export function bandColor(band) {
  if (band === 'STRONG_BUY' || band === 'BUY') return 'text-green-600';
  if (band === 'STRONG_SELL' || band === 'SELL') return 'text-red-600';
  return 'text-slate-500';
}
