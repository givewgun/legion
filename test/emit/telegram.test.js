import { describe, it, expect, vi } from 'vitest';
import { sendTelegram, formatSignal } from '../../src/emit/telegram.js';

describe('sendTelegram', () => {
  it('posts text to the bot sendMessage endpoint', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    await sendTelegram('TOKEN', '123', 'hello', fetchMock);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ chat_id: '123', text: 'hello', parse_mode: 'MarkdownV2' });
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
    expect(text).toContain('STRONG\\_BUY'); // band underscore escaped for MarkdownV2
    expect(text).toContain('90%');
    expect(text).toContain('technical');
  });

  it('escapes MarkdownV2 control characters in dynamic fields', () => {
    const text = formatSignal({
      symbol: 'NVDA',
      band: 'STRONG_BUY',
      conviction: 0.9,
      plan: { rationales: [{ agentId: 'technical', rationale: 'break_out (x) *now*' }] },
    });
    // reserved chars from the rationale are backslash-escaped, not raw
    expect(text).toContain('break\\_out \\(x\\) \\*now\\*');
    expect(text).not.toContain('break_out (x) *now*');
  });

  it('warns when the signal came from a degraded panel', () => {
    const text = formatSignal({
      symbol: 'NVDA',
      band: 'BUY',
      conviction: 0.5,
      plan: { degradedQuorum: true, nEff: 2, rationales: [] },
    });
    expect(text).toContain('degraded panel');
    expect(text).toContain('2 agents');
  });

  it('omits the degraded warning on a full panel', () => {
    const text = formatSignal({
      symbol: 'NVDA',
      band: 'BUY',
      conviction: 0.5,
      plan: { rationales: [] },
    });
    expect(text).not.toContain('degraded');
  });
});
