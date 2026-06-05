import { describe, it, expect, vi } from 'vitest';
import { fetchAaii } from '../../../src/data/feeds/aaii.js';

const okText = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => text,
});

const failResponse = { ok: false, status: 500, text: async () => '' };

// Realistic HTML fixture with several tableTxt percent cells; first three are
// Bullish 36.3 / Neutral 26.7 / Bearish 37.0. Extra cells follow to confirm
// "first three" logic.
const FIXTURE_HTML = `
<html><body>
<table>
  <tr>
    <td align="right" class="tableTxt">36.3% </td>
    <td align="right" class="tableTxt">26.7%</td>
    <td align="right" class="tableTxt">37.0% </td>
    <td align="right" class="tableTxt">42.1%</td>
    <td align="right" class="tableTxt">22.3%</td>
  </tr>
</table>
</body></html>
`;

describe('fetchAaii', () => {
  it('parses bullish, neutral, bearish and derives spread from HTML fixture', async () => {
    const fetchImpl = vi.fn(async () => okText(FIXTURE_HTML));
    const res = await fetchAaii({ fetchImpl, url: 'http://x/aaii' });
    expect(res).toEqual({
      bullish: 36.3,
      neutral: 26.7,
      bearish: 37.0,
      spread: expect.closeTo(36.3 - 37.0, 5),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns null when the page has no tableTxt percent cells', async () => {
    const fetchImpl = vi.fn(async () => okText('<html><body><p>no data</p></body></html>'));
    expect(await fetchAaii({ fetchImpl, url: 'http://x/aaii' })).toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => failResponse);
    expect(await fetchAaii({ fetchImpl, url: 'http://x/aaii' })).toBeNull();
  });
});
