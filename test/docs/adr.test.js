import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const files = [
  '0001-consensus-protocol',
  '0002-message-bus',
  '0003-inference-abstraction',
  '0004-deployment',
];

describe('ADRs', () => {
  for (const f of files) {
    it(`${f} has Context, Decision, Consequences`, () => {
      const md = readFileSync(
        fileURLToPath(new URL(`../../docs/adr/${f}.md`, import.meta.url)),
        'utf8',
      ).toLowerCase();
      expect(md).toContain('## context');
      expect(md).toContain('## decision');
      expect(md).toContain('## consequences');
      expect(md).toContain('## status');
    });
  }
});
