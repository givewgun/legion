import { describe, it, expect, vi } from 'vitest';
import { fetchPutCall } from '../../../src/data/feeds/cboe.js';

const okText = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => text,
});

const CSV = `Cboe Equity Volume and Put/Call Ratios
DATE,CALL,PUT,TOTAL,P/C Ratio
06/20/2026,710358,425416,1135774,0.60
06/21/2026,628619,403696,1032315,0.64`;

describe('fetchPutCall', () => {
  it('parses the ratio from the last data row of the CSV', async () => {
    const fetchImpl = vi.fn(async () => okText(CSV));
    const res = await fetchPutCall({ fetchImpl, url: 'http://x/pc.csv' });
    expect(res).toEqual({ ratio: 0.64, date: '06/21/2026' });
  });

  it('returns null when the CSV has no parseable data rows', async () => {
    const fetchImpl = vi.fn(async () => okText('header only\nno,data,here'));
    expect(await fetchPutCall({ fetchImpl, url: 'http://x/pc.csv' })).toBeNull();
  });

  it('returns null when the source errors', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }));
    expect(await fetchPutCall({ fetchImpl, url: 'http://x/pc.csv' })).toBeNull();
  });
});
