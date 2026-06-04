import { describe, it, expect } from 'vitest';
import { health } from '../src/health.js';

describe('health', () => {
  it('reports ok status', () => {
    expect(health()).toEqual({ name: 'legion', status: 'ok' });
  });
});
