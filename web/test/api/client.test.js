import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../../src/api/client.js';

beforeEach(() => {
  global.fetch = vi.fn();
});

function ok(body) {
  return { ok: true, json: async () => body };
}

describe('api client', () => {
  it('lists tickers', async () => {
    global.fetch.mockResolvedValue(ok([{ symbol: 'NVDA', enabled: true }]));
    const rows = await api.listTickers();
    expect(global.fetch).toHaveBeenCalledWith('/api/tickers');
    expect(rows[0].symbol).toBe('NVDA');
  });

  it('adds a ticker via POST', async () => {
    global.fetch.mockResolvedValue(ok({ symbol: 'AMD', enabled: true }));
    await api.addTicker('amd');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/tickers');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ symbol: 'amd' });
  });

  it('toggles a ticker via PATCH', async () => {
    global.fetch.mockResolvedValue(ok({ symbol: 'NVDA', enabled: false }));
    await api.setTicker('NVDA', false);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/tickers/NVDA');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ enabled: false });
  });

  it('fetches a debate', async () => {
    global.fetch.mockResolvedValue(ok({ id: 9, rounds: [] }));
    const d = await api.getDebate(9);
    expect(global.fetch).toHaveBeenCalledWith('/api/cycles/9');
    expect(d.id).toBe(9);
  });

  it('throws on a non-ok response', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(api.listSignals()).rejects.toThrow('API GET /api/signals failed: 500');
  });
});
