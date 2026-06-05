import { describe, it, expect, vi } from 'vitest';
import { sendTelegram, formatSignal } from '../../src/emit/telegram.js';

describe('sendTelegram', () => {
  it('posts text to the bot sendMessage endpoint', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    await sendTelegram('TOKEN', '123', 'hello', fetchMock);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ chat_id: '123', text: 'hello', parse_mode: 'Markdown' });
  });

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    await expect(sendTelegram('T', '1', 'x', fetchMock)).rejects.toThrow(
      'Telegram sendMessage failed: 401',
    );
  });
});

describe('formatSignal', () => {
  it('renders a readable signal message', () => {
    const text = formatSignal({
      symbol: 'NVDA',
      band: 'STRONG_BUY',
      conviction: 0.9,
      plan: { rationales: [{ agentId: 'technical', rationale: 'breakout' }] },
    });
    expect(text).toContain('NVDA');
    expect(text).toContain('STRONG_BUY');
    expect(text).toContain('90%');
    expect(text).toContain('technical');
  });
});
