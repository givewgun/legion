// GunVest's GET /api/news/:ticker returns ~20 items all stamped with the
// requested ticker, but most are broad-market/off-topic, relatedTickers is
// usually empty, and each carries junk fields (id, url, imageUrl). Dumping that
// raw at a small local model buries the signal and produces unparseable votes.
// This trims each item to a lean set, ranks the genuinely on-topic ones first,
// and caps the count — while never hard-dropping, since a ticker's name rarely
// equals its symbol (TSM → "Taiwan Semiconductor"), so the LLM still judges.

const DefaultLimit = 10;
const LeanFields = ['headline', 'summary', 'source', 'datetime', 'sentiment', 'category'];

function project(item) {
  const out = {};
  for (const field of LeanFields) {
    if (item[field] !== undefined) out[field] = item[field];
  }
  return out;
}

function publishedAt(item) {
  const t = Date.parse(item?.datetime);
  return Number.isNaN(t) ? 0 : t;
}

function mentionsSymbol(item, symbol) {
  const text = `${item?.headline ?? ''} ${item?.summary ?? ''}`;
  if (new RegExp(`\\b${symbol}\\b`, 'i').test(text)) return true;
  const related = Array.isArray(item?.relatedTickers) ? item.relatedTickers : [];
  return related.some((t) => String(t).toUpperCase() === symbol);
}

export function shapeHeadlines(news, symbol, { limit = DefaultLimit } = {}) {
  if (!Array.isArray(news)) return [];
  const sym = String(symbol ?? '').toUpperCase();

  const byRecency = [...news].sort((a, b) => publishedAt(b) - publishedAt(a));
  const onTopic = [];
  const rest = [];
  for (const item of byRecency) {
    (mentionsSymbol(item, sym) ? onTopic : rest).push(project(item));
  }
  return [...onTopic, ...rest].slice(0, limit);
}
