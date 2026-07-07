import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { createWebullBroker, signWebullRequest, DefaultWebullHost } from '../../src/broker/webull.js';

const AppKey = 'test-app-key';
const AppSecret = 'test-app-secret';
const FixedDate = new Date('2026-07-07T04:00:00.000Z');
const FixedNonce = 'nonce-1234';

// Scripted fetch: each call shifts the next expectation; unmatched path throws.
function scriptedFetch(script) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const step = script.shift();
    if (!step) throw new Error(`unexpected fetch ${url}`);
    expect(String(url)).toContain(step.path);
    if (step.method) expect(opts.method ?? 'GET').toBe(step.method);
    calls.push({ url: String(url), opts });
    return {
      ok: step.status ? step.status < 400 : true,
      status: step.status ?? 200,
      json: async () => step.json,
      text: async () => JSON.stringify(step.json ?? ''),
    };
  };
  return { impl, calls };
}

function makeBroker(script, overrides = {}) {
  const { impl, calls } = scriptedFetch(script);
  const broker = createWebullBroker({
    appKey: AppKey,
    appSecret: AppSecret,
    fetchImpl: impl,
    logger: { warn: () => {} },
    clock: () => FixedDate,
    nonce: () => FixedNonce,
    ...overrides,
  });
  return { broker, calls };
}

const accountListStep = (accounts = [{ account_id: 'ACC-1', account_type: 'CASH' }]) => ({
  path: '/openapi/account/list',
  json: accounts,
});

describe('webull signature', () => {
  it('matches the reference scheme (sorted params, body hash, percent-encoded HMAC)', () => {
    const body = { account_id: 'ACC-1' };
    const sig = signWebullRequest({
      appKey: AppKey,
      appSecret: AppSecret,
      host: DefaultWebullHost,
      path: '/openapi/trade/order/place',
      body,
      timestamp: '2026-07-07T04:00:00Z',
      nonce: FixedNonce,
    });
    // Reference computation, spelled out independently of the implementation.
    const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex').toUpperCase();
    const params = {
      host: DefaultWebullHost,
      'x-app-key': AppKey,
      'x-signature-algorithm': 'HMAC-SHA256',
      'x-signature-nonce': FixedNonce,
      'x-signature-version': '1.0',
      'x-timestamp': '2026-07-07T04:00:00Z',
    };
    const sorted = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    const stringToSign = encodeURIComponent(`/openapi/trade/order/place&${sorted}&${bodyHash}`)
      .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const expected = createHmac('sha256', `${AppSecret}&`).update(stringToSign).digest('base64');
    expect(sig).toBe(expected);
  });

  it('folds query params into the signed string', () => {
    const withQuery = signWebullRequest({
      appKey: AppKey, appSecret: AppSecret, host: DefaultWebullHost,
      path: '/openapi/assets/balance', query: { account_id: 'ACC-1' },
      timestamp: '2026-07-07T04:00:00Z', nonce: FixedNonce,
    });
    const without = signWebullRequest({
      appKey: AppKey, appSecret: AppSecret, host: DefaultWebullHost,
      path: '/openapi/assets/balance',
      timestamp: '2026-07-07T04:00:00Z', nonce: FixedNonce,
    });
    expect(withQuery).not.toBe(without);
  });
});

describe('webull adapter', () => {
  it('init resolves the sole account and sends the signed headers', async () => {
    const { broker, calls } = makeBroker([accountListStep()]);
    expect(await broker.init()).toEqual({ accountId: 'ACC-1' });
    const { headers } = calls[0].opts;
    expect(headers['x-app-key']).toBe(AppKey);
    expect(headers['x-timestamp']).toBe('2026-07-07T04:00:00Z');
    expect(headers['x-signature-algorithm']).toBe('HMAC-SHA256');
    expect(headers['x-signature-nonce']).toBe(FixedNonce);
    expect(headers['x-version']).toBe('v2');
    expect(headers['x-signature']).toBeTruthy();
  });

  it('init requires accountId when several accounts are visible', async () => {
    const accounts = [{ account_id: 'A' }, { account_id: 'B' }];
    const { broker } = makeBroker([accountListStep(accounts)]);
    await expect(broker.init()).rejects.toThrow(/set accountId/);

    const { broker: picked } = makeBroker([accountListStep(accounts)], { accountId: 'B' });
    expect(await picked.init()).toEqual({ accountId: 'B' });
  });

  it('init rejects an accountId missing from the account list', async () => {
    const { broker } = makeBroker([accountListStep()], { accountId: 'NOPE' });
    await expect(broker.init()).rejects.toThrow(/not in account list/);
  });

  it('getAccountSummary maps totals and falls back to marks + cash', async () => {
    const { broker } = makeBroker([
      accountListStep(),
      { path: '/openapi/assets/balance', json: { total_net_liquidation_value: '100500', total_cash_balance: '40000' } },
      { path: '/openapi/assets/balance', json: { total_market_value: '60500', total_cash_balance: '40000' } },
    ]);
    expect(await broker.getAccountSummary()).toEqual({ accountId: 'ACC-1', equity: 100500, cash: 40000 });
    expect(await broker.getAccountSummary()).toEqual({ accountId: 'ACC-1', equity: 100500, cash: 40000 });
  });

  it('getPositions maps fields and drops zero rows', async () => {
    const { broker } = makeBroker([
      accountListStep(),
      { path: '/openapi/assets/positions', json: [
        { symbol: 'AAPL', quantity: '10', cost_price: '180', instrument_type: 'EQUITY' },
        { symbol: 'OLD', quantity: '0', cost_price: '50', instrument_type: 'EQUITY' },
      ] },
    ]);
    expect(await broker.getPositions()).toEqual([
      { symbol: 'AAPL', qty: 10, avgCost: 180, instrumentType: 'EQUITY' },
    ]);
  });

  it('placeOrder submits a namespaced MARKET DAY order and returns order_id', async () => {
    const { broker, calls } = makeBroker([
      accountListStep(),
      { path: '/openapi/trade/order/place', method: 'POST', json: { order_id: 'WB-987', client_order_id: 'legion7' } },
    ]);
    const r = await broker.placeOrder({ symbol: 'AAPL', side: 'BUY', qty: 10, clientOrderId: '7' });
    expect(r).toEqual({ brokerOrderId: 'WB-987' });
    const placeCall = calls[1];
    expect(placeCall.opts.headers.category).toBe('US_EQUITY');
    const body = JSON.parse(placeCall.opts.body);
    expect(body.account_id).toBe('ACC-1');
    expect(body.new_orders[0]).toMatchObject({
      client_order_id: 'legion7',
      combo_type: 'NORMAL',
      symbol: 'AAPL',
      instrument_type: 'EQUITY',
      market: 'US',
      order_type: 'MARKET',
      quantity: '10',
      side: 'BUY',
      time_in_force: 'DAY',
      entrust_type: 'QTY',
    });
  });

  it('placeOrder throws on an unexpected response shape', async () => {
    const { broker } = makeBroker([
      accountListStep(),
      { path: '/openapi/trade/order/place', method: 'POST', json: { msg: 'weird' } },
    ]);
    await expect(broker.placeOrder({ symbol: 'AAPL', side: 'BUY', qty: 1, clientOrderId: '9' }))
      .rejects.toThrow(/unexpected order response/);
  });

  it('getOrderStatus unwraps the combo detail and maps statuses', async () => {
    const detail = (status, extra = {}) => ({
      path: '/openapi/trade/order/detail',
      json: { client_order_id: 'legion7', combo_type: 'NORMAL', orders: [{ order_id: 'WB-987', status, ...extra }] },
    });
    const { broker } = makeBroker([
      accountListStep(),
      detail('FILLED', { filled_quantity: '10', filled_price: '190.5' }),
      detail('PARTIAL FILLED', { filled_quantity: '4' }),
      detail('CANCELLED'),
      detail('FAILED'),
      detail('SOMETHING_NEW'),
    ]);
    expect(await broker.getOrderStatus('7')).toEqual({
      found: true, status: 'filled', brokerOrderId: 'WB-987', fillQty: 10, avgFillPrice: 190.5,
    });
    expect((await broker.getOrderStatus('7')).status).toBe('submitted'); // partial fill still working
    expect((await broker.getOrderStatus('7')).status).toBe('cancelled');
    expect((await broker.getOrderStatus('7')).status).toBe('cancelled'); // FAILED is terminal-unfilled
    expect((await broker.getOrderStatus('7')).status).toBe('submitted'); // unmapped -> safe default
  });

  it('getOrderStatus reports not-found on 404 and on an empty detail', async () => {
    const { broker } = makeBroker([
      accountListStep(),
      { path: '/openapi/trade/order/detail', status: 404, json: { code: 'ORDER_NOT_FOUND' } },
      { path: '/openapi/trade/order/detail', json: {} },
    ]);
    expect(await broker.getOrderStatus('7')).toEqual({ found: false });
    expect(await broker.getOrderStatus('7')).toEqual({ found: false });
  });

  it('isAuthenticated is false when the API rejects the key', async () => {
    const { broker } = makeBroker([
      { path: '/openapi/account/list', status: 401, json: { code: 'INVALID_KEY' } },
    ]);
    expect(await broker.isAuthenticated()).toBe(false);
  });

  it('strips a pasted scheme from the host override', async () => {
    const { broker, calls } = makeBroker([accountListStep()], { apiHost: 'https://api.sandbox.webull.co.th/' });
    await broker.init();
    expect(calls[0].url).toContain('https://api.sandbox.webull.co.th/openapi/account/list');
  });
});
