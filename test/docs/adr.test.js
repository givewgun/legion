import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const files = [
  '0001-consensus-protocol',
  '0002-message-bus',
  '0003-inference-abstraction',
  '0004-deployment',
  '0005-ollama-serial-inference',
  '0006-gunvest-client-resilience',
  '0007-gunvest-data-source',
  '0008-reliability-weighting',
  '0009-self-evaluation',
  '0010-vote-contract-parsing',
  '0011-risk-manager-constraint',
  '0012-dashboard-read-write-split',
  '0013-schema-management',
];

describe('ADRs', () => {
  for (const f of files) {
    it(`${f} has Status, Context, Decision, Alternatives, Consequences`, () => {
      const md = readFileSync(
        fileURLToPath(new URL(`../../docs/adr/${f}.md`, import.meta.url)),
        'utf8',
      ).toLowerCase();
      expect(md).toContain('## status');
      expect(md).toContain('## context');
      expect(md).toContain('## decision');
      expect(md).toContain('## alternatives considered');
      expect(md).toContain('## consequences');
    });
  }
});

describe('architecture overview', () => {
  const md = readFileSync(
    fileURLToPath(new URL('../../docs/ARCHITECTURE.md', import.meta.url)),
    'utf8',
  );

  it('exists with renderable mermaid diagrams', () => {
    const mermaidBlocks = md.match(/```mermaid/g) ?? [];
    expect(mermaidBlocks.length).toBeGreaterThanOrEqual(7);
  });

  it('links every ADR from the index', () => {
    for (const f of files) {
      expect(md).toContain(`adr/${f}.md`);
    }
  });
});
