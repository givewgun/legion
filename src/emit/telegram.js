export async function sendTelegram(token, chatId, text, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status}`);
  return res.json();
}

export function formatSignal(signal) {
  const pct = Math.round(signal.conviction * 100);
  const lines = [
    `*Legion signal: ${signal.symbol}*`,
    `Call: *${signal.band}*  (conviction ${pct}%)`,
    '',
    ...signal.plan.rationales.map((r) => `• _${r.agentId}_: ${r.rationale}`),
  ];
  return lines.join('\n');
}
