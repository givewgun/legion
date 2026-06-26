import { describe, it, expect, vi } from 'vitest';
import { createQualityService } from '../../src/quality/index.js';

describe('quality service', () => {
  it('fetches fundamentals + moat and returns a qualityMult', async () => {
    const gunvest = { getFundamentals: vi.fn(async () => ({ trailingPE: 20, pegRatio: 1, profitMargins: 0.2, returnOnEquity: 0.2, revenueGrowth: 0.2, debtToEquity: 50, freeCashflow: 1, numberOfAnalystOpinions: 5, recommendationKey: 'buy', targetMeanPrice: 120 })) };
    const moatScorer = async () => 0.7;
    const svc = createQualityService({ gunvest, moatScorer });
    const q = await svc.getQuality('NVDA', 100);
    expect(q.qualityMult).toBeGreaterThan(1.0);
    expect(gunvest.getFundamentals).toHaveBeenCalledWith('NVDA');
  });

  it('caches within the TTL (one fetch for two calls)', async () => {
    const gunvest = { getFundamentals: vi.fn(async () => ({ trailingPE: 20 })) };
    const svc = createQualityService({ gunvest });
    await svc.getQuality('NVDA', 100);
    await svc.getQuality('NVDA', 100);
    expect(gunvest.getFundamentals).toHaveBeenCalledTimes(1);
  });

  it('degrades to neutral when gunvest throws', async () => {
    const gunvest = { getFundamentals: vi.fn(async () => { throw new Error('down'); }) };
    const svc = createQualityService({ gunvest, logger: { warn() {} } });
    const q = await svc.getQuality('NVDA', 100);
    expect(q.qualityMult).toBeCloseTo(1.0, 5);
    expect(q.flags).toContain('quality:fundamentals-missing');
  });
});
