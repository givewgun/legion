import { describe, it, expect, vi } from 'vitest';
import { fetchNaaim } from '../../../src/data/feeds/naaim.js';

const okText = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => text,
});

const failResponse = { ok: false, status: 500, text: async () => '' };

// Fixture: decoy number 99.9 appears in a paragraph BEFORE the key-stat marker
// (but does NOT contain the literal text "key-stat"), so it must be ignored.
// First key-stat value is 86.82 (current NAAIM exposure).
const FIXTURE_HTML_SIMPLE = `
<html><body>
  <p>Some trailing context >99.9< unrelated</p>
  <div id="key-stat-section">
    <p class="something">
      >86.82<
    </p>
    <p>>98.39<</p>
  </div>
</body></html>
`;

describe('fetchNaaim', () => {
  it('parses exposure from key-stat region, ignoring decoy before marker', async () => {
    const fetchImpl = vi.fn(async () => okText(FIXTURE_HTML_SIMPLE));
    const res = await fetchNaaim({ fetchImpl, url: 'http://x/naaim' });
    expect(res).toEqual({ exposure: 86.82, date: null });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns null when no key-stat value is present', async () => {
    const fetchImpl = vi.fn(async () => okText('<html><body><p>no data</p></body></html>'));
    expect(await fetchNaaim({ fetchImpl, url: 'http://x/naaim' })).toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => failResponse);
    expect(await fetchNaaim({ fetchImpl, url: 'http://x/naaim' })).toBeNull();
  });

  it('parses a negative exposure value', async () => {
    const fetchImpl = vi.fn(async () =>
      okText('<html><body>key-stat <p>>-12.5<</p></body></html>'),
    );
    expect(await fetchNaaim({ fetchImpl, url: 'http://x/naaim' })).toEqual({
      exposure: -12.5,
      date: null,
    });
  });
});
