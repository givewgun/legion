import { describe, it, expect } from 'vitest';
import { locationForSource } from '../../src/llm/source.js';

describe('locationForSource', () => {
  it('maps pc to onprem', () => {
    expect(locationForSource('pc')).toBe('onprem');
  });
  it('maps every other backend to cloud', () => {
    for (const s of ['oracle', 'openai', 'gemini']) expect(locationForSource(s)).toBe('cloud');
  });
  it('returns null for a null/absent source', () => {
    expect(locationForSource(null)).toBeNull();
    expect(locationForSource(undefined)).toBeNull();
  });
});
