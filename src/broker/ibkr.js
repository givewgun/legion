// IBKR Client Portal Web API adapter, reached through an IBeam gateway container
// (ADR 0035). IBeam owns login + session keepalive; this adapter only makes
// authenticated REST calls. The gateway serves HTTPS with a self-signed cert, so
// the default fetch uses an undici dispatcher that skips TLS verification for
// gateway calls ONLY (never a global override). All methods lazily init():
// account discovery + the paper-account assertion happen before any trade call.
import { Agent, fetch as undiciFetch } from 'undici';

// CP order placement can return a chain of precautionary dialogs; each POST
// /iserver/reply answers one. Cap the chain so a misbehaving gateway can't loop.
const MaxReplyRounds = 5;
const PaperAccountPrefix = 'D';

const StatusMap = {
  filled: 'filled',
  cancelled: 'cancelled',
  inactive: 'cancelled',
  submitted: 'submitted',
  presubmitted: 'submitted',
  pendingsubmit: 'submitted',
};

/**
 * Creates a broker adapter that talks to IBKR's Client Portal Web API through
 * an IBeam gateway.
 *
 * @param {object} opts
 * @param {string} opts.gatewayUrl - Base URL of the IBeam gateway (e.g. `https://ibeam:5000/v1/api`).
 * @param {(url: string, opts?: object) => Promise<Response>} [opts.fetchImpl] - Override for the fetch used to reach the gateway (tests inject a scripted fetch).
 * @param {boolean} [opts.allowLive] - Allow a non-paper (non-`D`-prefixed) account id at init. Defaults to false.
 * @param {Console} [opts.logger] - Logger for non-fatal warnings (e.g. order confirmation dialogs).
 * @returns {object} broker - see `src/broker/broker.js` for the interface surface.
 */
export function createIbkrBroker({ gatewayUrl, fetchImpl, allowLive = false, logger = console }) {
  const base = gatewayUrl.replace(/\/$/, '');
  const fetcher =
    fetchImpl ??
    ((url, opts) =>
      undiciFetch(url, { ...opts, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }));

  let accountId = null;
  const conidCache = new Map(); // symbol -> conid

  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetcher(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`IBKR ${method} ${path} -> ${res.status}`);
    return res.json();
  }

  async function init() {
    if (accountId) return { accountId };
    const auth = await call('/iserver/auth/status', { method: 'POST' }).catch(() => call('/iserver/auth/status'));
    if (!auth?.authenticated) throw new Error('IBKR gateway not authenticated');
    const acct = await call('/iserver/accounts');
    const id = acct?.selectedAccount ?? acct?.accounts?.[0];
    if (!id) throw new Error('IBKR: no account returned');
    if (!id.startsWith(PaperAccountPrefix) && !allowLive) {
      throw new Error(`IBKR: refusing live account ${id} (set LEGION_ALLOW_LIVE_BROKER=true to override)`);
    }
    await call('/portfolio/accounts'); // primes /portfolio/* endpoints (CP quirk)
    accountId = id;
    return { accountId };
  }

  async function resolveConid(symbol) {
    if (conidCache.has(symbol)) return conidCache.get(symbol);
    const results = await call(`/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`);
    const hit = (results ?? []).find((r) => r.symbol === symbol) ?? results?.[0];
    if (!hit?.conid) throw new Error(`IBKR: unknown symbol ${symbol}`);
    const conid = Number(hit.conid);
    conidCache.set(symbol, conid);
    return conid;
  }

  return {
    init,

    async isAuthenticated() {
      try {
        const auth = await call('/iserver/auth/status', { method: 'POST' }).catch(() => call('/iserver/auth/status'));
        return !!auth?.authenticated;
      } catch {
        return false;
      }
    },

    async getAccountSummary() {
      await init();
      const s = await call(`/portfolio/${accountId}/summary`);
      return {
        accountId,
        equity: Number(s?.netliquidation?.amount ?? 0),
        cash: Number(s?.totalcashvalue?.amount ?? 0),
      };
    },

    async getPositions() {
      await init();
      const rows = await call(`/portfolio/${accountId}/positions/0`);
      return (rows ?? [])
        .filter((p) => Number(p.position) !== 0)
        .map((p) => ({
          symbol: p.ticker ?? p.contractDesc,
          qty: Number(p.position),
          avgCost: Number(p.avgCost ?? 0),
          conid: Number(p.conid),
        }));
    },

    async placeOrder({ symbol, side, qty, clientOrderId }) {
      await init();
      const conid = await resolveConid(symbol);
      let resp = await call(`/iserver/account/${accountId}/orders`, {
        method: 'POST',
        body: { orders: [{ conid, orderType: 'MKT', side, quantity: qty, tif: 'DAY', cOID: clientOrderId }] },
      });
      for (let round = 0; round < MaxReplyRounds; round++) {
        const first = Array.isArray(resp) ? resp[0] : resp;
        if (first?.order_id) return { brokerOrderId: String(first.order_id) };
        if (!first?.id) throw new Error(`IBKR: unexpected order response ${JSON.stringify(resp)}`);
        logger.warn?.(`[ibkr] confirming order dialog for ${symbol}: ${JSON.stringify(first.message ?? [])}`);
        resp = await call(`/iserver/reply/${first.id}`, { method: 'POST', body: { confirmed: true } });
      }
      throw new Error('IBKR: order confirmation loop exceeded MaxReplyRounds');
    },

    async getOrderStatus(clientOrderId) {
      await init();
      const data = await call('/iserver/account/orders');
      const o = (data?.orders ?? []).find((x) => x.order_ref === clientOrderId);
      if (!o) return { found: false };
      const status = StatusMap[String(o.status ?? '').toLowerCase()] ?? 'submitted';
      return {
        found: true,
        status,
        fillQty: Number(o.filledQuantity ?? 0),
        avgFillPrice: Number(o.avgPrice ?? o.average_price ?? 0),
      };
    },
  };
}
