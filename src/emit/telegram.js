export async function sendTelegram(token, chatId, text, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'MarkdownV2' }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status}`);
  return res.json();
}

// Escapes Telegram MarkdownV2 reserved characters in dynamic text (LLM rationales,
// agent ids, ticker/band). Legacy 'Markdown' has no escape mechanism, so we use
// MarkdownV2 and escape every reserved char per the Bot API spec. Static template
// punctuation that we intend as formatting is added after escaping.
function escapeMarkdown(value) {
  return String(value).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

export function formatSignal(signal) {
  const pct = Math.round(signal.conviction * 100);
  const lines = [
    `*Legion signal: ${escapeMarkdown(signal.symbol)}*`,
    `Call: *${escapeMarkdown(signal.band)}* \\(conviction ${pct}%\\)`,
    '',
    ...signal.plan.rationales.map(
      (r) => `• _${escapeMarkdown(r.agentId)}_: ${escapeMarkdown(r.rationale)}`,
    ),
  ];
  return lines.join('\n');
}
