import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sql = readFileSync(
  fileURLToPath(new URL('../../src/db/schema.sql', import.meta.url)),
  'utf8',
).toLowerCase();

describe('phase4 schema DDL', () => {
  it('extends agent_reliability with rho and sample_size', () => {
    expect(sql).toContain('create table if not exists legion.agent_reliability');
    expect(sql).toContain('rho');
    expect(sql).toContain('sample_size');
  });
  it('creates signal_votes snapshot table', () => {
    expect(sql).toContain('create table if not exists legion.signal_votes');
    expect(sql).toContain('signal_id');
    expect(sql).toContain('agent_id');
  });
  it('extends backtest_results with hit_rate and pnl', () => {
    expect(sql).toContain('create table if not exists legion.backtest_results');
    expect(sql).toContain('hit_rate');
    expect(sql).toContain('pnl');
  });
  it('adds resolution columns to signals', () => {
    expect(sql).toContain('alter table legion.signals');
    expect(sql).toContain('resolved');
    expect(sql).toContain('forward_return');
    expect(sql).toContain('resolve_after');
  });
});
