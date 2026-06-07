import { describe, it, expect } from 'vitest';
import { agentInfo, AGENTS } from '../../src/lib/agents.js';

// lucide-react exports forwardRef objects, not plain functions.
// A valid React component is either a function or a forwardRef object
// ($$typeof === Symbol.for('react.forward_ref')).
function isReactComponent(val) {
  return (
    typeof val === 'function' || (typeof val === 'object' && val !== null && val.$$typeof != null)
  );
}

describe('agent identity map', () => {
  it('returns label, hex color, icon and class strings for known agents', () => {
    const tech = agentInfo('technical');
    expect(tech.label).toBe('Technical');
    expect(tech.hex).toMatch(/^#/);
    expect(isReactComponent(tech.Icon)).toBe(true); // lucide icon component
    expect(tech.classes.text).toBe('text-amber-700');
    expect(tech.classes.bg).toBe('bg-amber-100');
    expect(tech.classes.ring).toBe('ring-amber-200');
  });

  it('covers all four core agents', () => {
    expect(Object.keys(AGENTS).sort()).toEqual(
      ['contrarian', 'news', 'social', 'technical'].sort(),
    );
  });

  it('falls back gracefully for an unknown agent id', () => {
    const x = agentInfo('mystery');
    expect(x.label).toBe('mystery');
    expect(x.hex).toMatch(/^#/);
    expect(isReactComponent(x.Icon)).toBe(true);
  });
});
