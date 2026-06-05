import { describe, it, expect, vi } from 'vitest';
import { createScheduler } from '../src/scheduler.js';

describe('createScheduler', () => {
  it('kicks every enabled ticker once', async () => {
    const orchestrator = { kick: vi.fn(async () => 1) };
    const repo = { listEnabledTickers: vi.fn(async () => ['NVDA', 'MU']) };
    const kicked = await createScheduler({ orchestrator, repo }).runOnce();
    expect(kicked).toEqual(['NVDA', 'MU']);
    expect(orchestrator.kick).toHaveBeenCalledWith('NVDA');
    expect(orchestrator.kick).toHaveBeenCalledWith('MU');
  });

  it('continues past a failing ticker', async () => {
    const orchestrator = {
      kick: vi.fn(async (s) => {
        if (s === 'NVDA') throw new Error('boom');
        return 1;
      }),
    };
    const repo = { listEnabledTickers: vi.fn(async () => ['NVDA', 'MU']) };
    await createScheduler({ orchestrator, repo, logger: { error() {}, warn() {} } }).runOnce();
    expect(orchestrator.kick).toHaveBeenCalledTimes(2);
  });
});
