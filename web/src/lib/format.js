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

// Compact relative age, e.g. "just now", "5m", "3h", "2d". `now` is injectable
// for tests. Returns '' for nullish input.
export function timeAgo(ts, now = Date.now()) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const secs = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Signed integer for stance moves between rounds, e.g. +2 / -1 / 0.
export function signedDelta(n) {
  return n > 0 ? `+${n}` : String(n);
}
