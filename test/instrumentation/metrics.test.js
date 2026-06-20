import { describe, it, expect } from 'vitest';
import { ollamaThinkingChars, register } from '../../src/instrumentation/metrics.js';

describe('ollamaThinkingChars metric', () => {
  it('is registered under the expected name and observes values', async () => {
    expect(typeof ollamaThinkingChars.observe).toBe('function');
    ollamaThinkingChars.observe(1234);
    const text = await register.metrics();
    expect(text).toContain('legion_ollama_thinking_chars');
  });
});
