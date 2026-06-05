import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createRiskManager } from '../../src/risk/manager.js';
import { cycleSubject, constraintSubject } from '../../src/bus/subjects.js';

describe('createRiskManager', () => {
  it('publishes a deterministic constraint for each cycle round', async () => {
    const bus = createMemoryBus();
    const gunvest = {
      getPrice: async () => ({ changePercent: 1 }),
      getMacro: async () => ({ vix: 33 }),
    };
    const msgs = [];
    bus.subscribeJSON(constraintSubject('NVDA', 1), (m) => msgs.push(m));

    createRiskManager({ bus, gunvest }).start();
    bus.publishJSON(cycleSubject('NVDA'), { cycleId: 5, symbol: 'NVDA', round: 1 });

    await vi.waitFor(() => expect(msgs.length).toBe(1));
    expect(msgs[0]).toMatchObject({
      cycleId: 5,
      symbol: 'NVDA',
      round: 1,
      constraint: { capConviction: 0.5, blockBuy: false },
    });
  });

  it('emits a permissive constraint when risk data is unavailable', async () => {
    const bus = createMemoryBus();
    const gunvest = {
      getPrice: async () => {
        throw new Error('down');
      },
      getMacro: async () => ({ vix: 13 }),
    };
    const msgs = [];
    bus.subscribeJSON(constraintSubject('MU', 1), (m) => msgs.push(m));

    createRiskManager({ bus, gunvest, logger: { error() {}, warn() {} } }).start();
    bus.publishJSON(cycleSubject('MU'), { cycleId: 6, symbol: 'MU', round: 1 });

    await vi.waitFor(() => expect(msgs.length).toBe(1));
    expect(msgs[0].constraint).toEqual({
      capConviction: 1,
      blockBuy: false,
      reason: 'risk data unavailable',
    });
  });
});
