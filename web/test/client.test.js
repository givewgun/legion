import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('api client auth helpers', () => {
  it('getMe returns the user on 200', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 1, email: 'a@b.com' }) });
    expect(await api.getMe()).toEqual({ id: 1, email: 'a@b.com' });
  });

  it('getMe returns null on 401 instead of throwing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    expect(await api.getMe()).toBeNull();
  });

  it('addToWatchlist PUTs the symbol', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 201, json: async () => ({ symbols: ['NVDA'] }) });
    const out = await api.addToWatchlist('NVDA');
    expect(out).toEqual({ symbols: ['NVDA'] });
    expect(fetchMock).toHaveBeenCalledWith('/api/watchlist/NVDA', expect.objectContaining({ method: 'PUT' }));
  });

  it('getSettings GETs /api/settings', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ homePcEnabled: true }) });
    const out = await api.getSettings();
    expect(out).toEqual({ homePcEnabled: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/settings');
  });

  it('setSettings PUTs /api/settings with body', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ homePcEnabled: false }) });
    const out = await api.setSettings({ homePcEnabled: false });
    expect(out).toEqual({ homePcEnabled: false });
    expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT' }));
  });
});
