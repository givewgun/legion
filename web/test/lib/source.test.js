import { describe, it, expect } from 'vitest';
import { locationForSource } from '../../src/lib/source.js';

describe('locationForSource (web)', () => {
  it('maps pc to onprem, others to cloud, null to null', () => {
    expect(locationForSource('pc')).toBe('onprem');
    expect(locationForSource('oracle')).toBe('cloud');
    expect(locationForSource(null)).toBeNull();
  });
});
