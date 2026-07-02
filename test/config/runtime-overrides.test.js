import { describe, it, expect, vi } from 'vitest';
import { coerceRuntimeValue, applyRuntimeOverrides } from '../../src/config/runtime-overrides.js';
import { RUNTIME_KEYS } from '../../src/config/runtime-keys.js';

const baseCfg = () => ({
  home: { enabled: true, model: 'qwen3:14b', fallback: true, think: true, timeoutMs: 3600000, probeTimeoutMs: 1500 },
  ollama: { model: 'qwen2.5:7b-instruct', timeoutMs: 3600000, think: null },
});

describe('coerceRuntimeValue', () => {
  it('bool accepts true/false text, rejects others', () => {
    expect(coerceRuntimeValue('bool', 'true')).toEqual({ ok: true, value: true });
    expect(coerceRuntimeValue('bool', 'FALSE')).toEqual({ ok: true, value: false });
    expect(coerceRuntimeValue('bool', 'yes').ok).toBe(false);
  });

  it('tribool maps empty to null', () => {
    expect(coerceRuntimeValue('tribool', '')).toEqual({ ok: true, value: null });
    expect(coerceRuntimeValue('tribool', 'true')).toEqual({ ok: true, value: true });
    expect(coerceRuntimeValue('tribool', 'maybe').ok).toBe(false);
  });

  it('int parses integers, rejects NaN and floats', () => {
    expect(coerceRuntimeValue('int', '600000')).toEqual({ ok: true, value: 600000 });
    expect(coerceRuntimeValue('int', 'abc').ok).toBe(false);
    expect(coerceRuntimeValue('int', '1.5').ok).toBe(false);
  });

  it('string trims', () => {
    expect(coerceRuntimeValue('string', '  qwen3:8b ')).toEqual({ ok: true, value: 'qwen3:8b' });
  });
});

describe('applyRuntimeOverrides', () => {
  it('keeps env defaults when no overrides', () => {
    expect(applyRuntimeOverrides(baseCfg(), {})).toEqual(baseCfg());
  });

  it('overrides win over env defaults (DB > env)', () => {
    const out = applyRuntimeOverrides(baseCfg(), {
      home_model: 'qwen3:8b',
      home_fallback: 'false',
      home_timeout_ms: '600000',
      oracle_model: 'llama3.1:8b',
      oracle_think: 'true',
      oracle_timeout_ms: '1800000',
    });
    expect(out.home.model).toBe('qwen3:8b');
    expect(out.home.fallback).toBe(false);
    expect(out.home.timeoutMs).toBe(600000);
    expect(out.ollama.model).toBe('llama3.1:8b');
    expect(out.ollama.think).toBe(true);
    expect(out.ollama.timeoutMs).toBe(1800000);
    // untouched keys keep defaults
    expect(out.home.enabled).toBe(true);
  });

  it('an empty string for a string key is treated as no override', () => {
    const out = applyRuntimeOverrides(baseCfg(), { home_model: '' });
    expect(out.home.model).toBe('qwen3:14b');
  });

  it('ignores an invalid stored value with a warning, never throws', () => {
    const warn = vi.fn();
    const out = applyRuntimeOverrides(baseCfg(), { home_fallback: 'banana' }, { warn });
    expect(out.home.fallback).toBe(true); // unchanged
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not mutate the input cfg', () => {
    const cfg = baseCfg();
    applyRuntimeOverrides(cfg, { home_model: 'qwen3:8b' });
    expect(cfg.home.model).toBe('qwen3:14b');
  });

  it('every registry cfgPath resolves to a real location in cfg', () => {
    const cfg = baseCfg();
    for (const { cfgPath } of RUNTIME_KEYS) {
      const parts = cfgPath.split('.');
      const last = parts.pop();
      const parent = parts.reduce((cur, p) => cur?.[p], cfg);
      expect(parent, `missing parent for ${cfgPath}`).toBeDefined();
      expect(last in parent, `missing ${cfgPath}`).toBe(true);
    }
  });
});
