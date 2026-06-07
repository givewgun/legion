import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const doc = readFileSync(
  fileURLToPath(new URL('../../docs/adding-an-agent.md', import.meta.url)),
  'utf8',
).toLowerCase();

describe('adding-an-agent guide', () => {
  it('documents the four module parts', () => {
    for (const part of ['config', 'gather', 'prompt', 'index']) {
      expect(doc).toContain(part);
    }
  });
  it('explains the prior weight and roster registration', () => {
    expect(doc).toContain('weight');
    expect(doc).toContain('roster');
  });
  it('covers consensus impact (N changes f and quorum)', () => {
    expect(doc).toContain('quorum');
  });
});
