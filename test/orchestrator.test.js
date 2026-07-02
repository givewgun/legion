import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../src/bus/memory.js';
import { createOrchestrator } from '../src/orchestrator.js';
import { cycleSubject, stopSubject } from '../src/bus/subjects.js';

describe('createOrchestrator', () => {
  it('creates a cycle and publishes the kick-off', async () => {
    const bus = createMemoryBus();
    const repo = { createCycle: vi.fn(async () => 77) };
    const msgs = [];
    bus.subscribeJSON(cycleSubject('NVDA'), (m) => msgs.push(m));

    const orch = createOrchestrator({ bus, repo });
    const cycleId = await orch.kick('NVDA');

    expect(cycleId).toBe(77);
    expect(repo.createCycle).toHaveBeenCalledWith('NVDA');
    expect(msgs[0]).toEqual({ cycleId: 77, symbol: 'NVDA', round: 1 });
  });

  it('uppercases the symbol', async () => {
    const bus = createMemoryBus();
    const repo = { createCycle: vi.fn(async () => 1) };
    const orch = createOrchestrator({ bus, repo });
    await orch.kick('mu');
    expect(repo.createCycle).toHaveBeenCalledWith('MU');
  });

  it('publishes a stop request for the ticker (no DB write)', () => {
    const bus = createMemoryBus();
    const repo = { createCycle: vi.fn() };
    const msgs = [];
    bus.subscribeJSON(stopSubject('NVDA'), (m) => msgs.push(m));

    createOrchestrator({ bus, repo }).stop('nvda');

    expect(msgs).toEqual([{ symbol: 'NVDA' }]);
    expect(repo.createCycle).not.toHaveBeenCalled();
  });
});
