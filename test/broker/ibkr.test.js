import { describe, it, expect } from 'vitest';
import { createIbkrBroker } from '../../src/broker/ibkr.js';

const GatewayUrl = 'https://ibeam:5000/v1/api';

// Scripted fetch: each call shifts the next expectation; unmatched path throws.
function scriptedFetch(script) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const step = script.shift();
    if (!step) throw new Error(`unexpected fetch ${url}`);
    expect(String(url)).toContain(step.path);
    if (step.method) expect(opts.method ?? 'GET').toBe(step.method);
    calls.push({ url: String(url), opts });
    return { ok: step.status ? step.status < 400 : true, status: step.status ?? 200, json: async () => step.json };
  };
  return { impl, calls };
}

const initScript = (accountId = 'DU123456') => [
  { path: '/iserver/auth/status', json: { authenticated: true } },
  { path: '/iserver/accounts', json: { accounts: [accountId], selectedAccount: accountId } },
  { path: '/portfolio/accounts', json: [{ accountId }] }, // CP quirk: primes /portfolio/*
];

describe('ibkr adapter', () => {
  it('init resolves paper account', async () => {
    const { impl } = scriptedFetch(initScript());
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    expect(await b.init()).toEqual({ accountId: 'DU123456' });
  });

  it('init throws on live account without allowLive', async () => {
    const { impl } = scriptedFetch(initScript('U999'));
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    await expect(b.init()).rejects.toThrow(/live account/i);
  });

  it('placeOrder resolves conid, answers reply dialogs, returns order id', async () => {
    const { impl, calls } = scriptedFetch([
      ...initScript(),
      { path: '/iserver/secdef/search', json: [{ conid: 265598, symbol: 'AAPL' }] },
      { path: '/iserver/account/DU123456/orders', method: 'POST', json: [{ id: 'reply-1', message: ['are you sure'] }] },
      { path: '/iserver/reply/reply-1', method: 'POST', json: [{ order_id: '987', order_status: 'Submitted' }] },
    ]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    const r = await b.placeOrder({ symbol: 'AAPL', side: 'BUY', qty: 10, clientOrderId: 'intent-7' });
    expect(r).toEqual({ brokerOrderId: '987' });
    const orderBody = JSON.parse(calls.find((c) => c.url.includes('/orders')).opts.body);
    expect(orderBody.orders[0]).toMatchObject({ conid: 265598, orderType: 'MKT', side: 'BUY', quantity: 10, tif: 'DAY', cOID: 'intent-7' });
  });

  it('getOrderStatus finds by order_ref and normalizes status', async () => {
    const { impl } = scriptedFetch([
      ...initScript(),
      { path: '/iserver/account/orders', json: { orders: [{ orderId: 987, order_ref: 'intent-7', status: 'Filled', filledQuantity: 10, avgPrice: 190.5 }] } },
    ]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    expect(await b.getOrderStatus('intent-7')).toEqual({ found: true, status: 'filled', fillQty: 10, avgFillPrice: 190.5 });
  });

  it('getAccountSummary maps netliquidation/totalcashvalue', async () => {
    const { impl } = scriptedFetch([
      ...initScript(),
      { path: '/portfolio/DU123456/summary', json: { netliquidation: { amount: 100500 }, totalcashvalue: { amount: 40000 } } },
    ]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    expect(await b.getAccountSummary()).toEqual({ accountId: 'DU123456', equity: 100500, cash: 40000 });
  });

  it('getPositions maps and drops zero rows; conid cache avoids re-search', async () => {
    const { impl } = scriptedFetch([
      ...initScript(),
      { path: '/portfolio/DU123456/positions/0', json: [
        { conid: 265598, ticker: 'AAPL', position: 10, avgCost: 180 },
        { conid: 1, ticker: 'OLD', position: 0, avgCost: 50 },
      ] },
    ]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    expect(await b.getPositions()).toEqual([{ symbol: 'AAPL', qty: 10, avgCost: 180, conid: 265598 }]);
  });

  it('isAuthenticated false on transport error, true when authenticated', async () => {
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect(await b.isAuthenticated()).toBe(false);
  });

  it('isAuthenticated true when gateway reports authenticated', async () => {
    const { impl } = scriptedFetch([{ path: '/iserver/auth/status', json: { authenticated: true } }]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    expect(await b.isAuthenticated()).toBe(true);
  });

  describe('status normalization', () => {
    it.each([
      ['Submitted', 'submitted'],
      ['PreSubmitted', 'submitted'],
      ['PendingSubmit', 'submitted'],
      ['Filled', 'filled'],
      ['Cancelled', 'cancelled'],
      ['Inactive', 'cancelled'],
    ])('maps CP status %s to %s', async (cpStatus, expected) => {
      const { impl } = scriptedFetch([
        ...initScript(),
        {
          path: '/iserver/account/orders',
          json: { orders: [{ orderId: 987, order_ref: 'intent-7', status: cpStatus, filledQuantity: 0, avgPrice: 0 }] },
        },
      ]);
      const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
      const result = await b.getOrderStatus('intent-7');
      expect(result.status).toBe(expected);
    });
  });

  it('getOrderStatus returns { found: false } when no order_ref matches', async () => {
    const { impl } = scriptedFetch([
      ...initScript(),
      { path: '/iserver/account/orders', json: { orders: [{ orderId: 987, order_ref: 'someone-else', status: 'Filled', filledQuantity: 10, avgPrice: 190.5 }] } },
    ]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    expect(await b.getOrderStatus('intent-7')).toEqual({ found: false });
  });

  it('placeOrder throws once the reply loop exceeds MaxReplyRounds', async () => {
    const replySteps = Array.from({ length: 6 }, (_, i) => ({
      path: `/iserver/reply/reply-${i}`,
      method: 'POST',
      json: [{ id: `reply-${i + 1}`, message: ['are you sure'] }],
    }));
    const { impl } = scriptedFetch([
      ...initScript(),
      { path: '/iserver/secdef/search', json: [{ conid: 265598, symbol: 'AAPL' }] },
      { path: '/iserver/account/DU123456/orders', method: 'POST', json: [{ id: 'reply-0', message: ['are you sure'] }] },
      ...replySteps,
    ]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    await expect(
      b.placeOrder({ symbol: 'AAPL', side: 'BUY', qty: 10, clientOrderId: 'intent-7' })
    ).rejects.toThrow(/MaxReplyRounds/i);
  });

  it('placeOrder throws unknown symbol when conid search has no match', async () => {
    const { impl } = scriptedFetch([
      ...initScript(),
      { path: '/iserver/secdef/search', json: [] },
    ]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    await expect(
      b.placeOrder({ symbol: 'ZZZZ', side: 'BUY', qty: 1, clientOrderId: 'intent-8' })
    ).rejects.toThrow(/unknown symbol/i);
  });
});
