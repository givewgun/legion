// Pure builder: turns a window of signals into a Telegram MarkdownV2 digest.
// stance is the numeric aggregate direction (-2..2). Output must be MarkdownV2-safe
// because sendTelegram() posts with parse_mode 'MarkdownV2'.
const LABEL = {
  '-2': 'STRONG SELL',
  '-1': 'SELL',
  0: 'HOLD',
  1: 'BUY',
  2: 'STRONG BUY',
};

// Escape MarkdownV2 reserved characters in dynamic text (symbols).
function escape(value) {
  return String(value).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function hhmm(ts) {
  return new Date(ts).toISOString().slice(11, 16);
}

export function buildSummary(signals, { since, until }) {
  const header = `*Legion digest* — ${hhmm(since)}–${hhmm(until)} UTC`;
  if (signals.length === 0) {
    return `${header}\n\nNo signals this window`;
  }

  const bullish = signals.filter((s) => s.stance > 0).length;
  const bearish = signals.filter((s) => s.stance < 0).length;
  const hold = signals.filter((s) => s.stance === 0).length;
  const counts = `${bullish} bullish · ${bearish} bearish · ${hold} hold`;

  const topCalls = signals
    .filter((s) => s.stance !== 0)
    .sort((a, b) => b.conviction - a.conviction)
    .slice(0, 10)
    .map((s) => `• *${escape(s.symbol)}* ${LABEL[s.stance]} ${(s.conviction * 100).toFixed(0)}%`)
    .join('\n');

  const body = topCalls ? `\n\n${topCalls}` : '';
  return `${header}\n${counts}${body}`;
}
