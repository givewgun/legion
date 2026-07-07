// Webull OpenAPI adapter (ADR 0036), built for Webull Thailand (host
// api.webull.co.th) but region-agnostic: every request is individually signed
// with the app key/secret from the developer portal (HMAC-SHA256 over a
// canonical string — the scheme implemented by webull-inc/webull-openapi-python-sdk),
// so there is no session or gateway container to keep alive. All methods lazily
// init(): account discovery + selection happen before any trade call.
import { createHash, createHmac, randomUUID } from 'node:crypto';

export const DefaultWebullHost = 'api.webull.co.th';

const ApiVersion = 'v2';
// Legion trades its US-listed watchlist through the account's US market access.
const Market = 'US';
const OrderCategory = `${Market}_EQUITY`;
// Webull requires a caller-chosen client_order_id (≤ 32 chars, unique). The
// executor keys everything on the intent id; this prefix namespaces those small
// integers away from any order the user places by hand with the same key.
const ClientOrderIdPrefix = 'legion';

const StatusMap = {
  filled: 'filled',
  cancelled: 'cancelled',
  failed: 'cancelled', // terminal-unfilled, same handling as a cancel
  submitted: 'submitted',
  'partial filled': 'submitted', // remainder still working
  partial_filled: 'submitted',
  pending: 'submitted',
};

// Python's urllib quote(safe=''): percent-encode everything outside the RFC 3986
// unreserved set. encodeURIComponent leaves !'()* alone, so finish those by hand.
function percentEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// ISO-8601 UTC at whole-second precision — the exact format the signature
// scheme expects in x-timestamp.
function isoSeconds(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Computes the Webull OpenAPI request signature.
 *
 * Canonical string: `uri & sorted(k=v of signed headers + query params) &
 * SHA256hex(compactBodyJSON).toUpperCase()`, percent-encoded whole, then
 * base64(HMAC-SHA256(encoded, appSecret + '&')).
 *
 * @param {object} p
 * @param {string} p.appKey - App key from the developer portal.
 * @param {string} p.appSecret - App secret from the developer portal.
 * @param {string} p.host - API host (no scheme), e.g. `api.webull.co.th`.
 * @param {string} p.path - Endpoint path, e.g. `/openapi/account/list`.
 * @param {object} [p.query] - Query params (also sent on the URL).
 * @param {object} [p.body] - JSON body (also sent as the request body).
 * @param {string} p.timestamp - ISO-8601 UTC seconds timestamp.
 * @param {string} p.nonce - Unique nonce per request.
 * @returns {string} The x-signature header value.
 */
export function signWebullRequest({ appKey, appSecret, host, path, query, body, timestamp, nonce }) {
  const params = {
    'x-app-key': appKey,
    'x-timestamp': timestamp,
    'x-signature-version': '1.0',
    'x-signature-algorithm': 'HMAC-SHA256',
    'x-signature-nonce': nonce,
    host,
    ...query,
  };
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  let stringToSign = `${path}&${sorted}`;
  if (body !== undefined) {
    stringToSign += `&${createHash('sha256').update(JSON.stringify(body)).digest('hex').toUpperCase()}`;
  }
  return createHmac('sha256', `${appSecret}&`).update(percentEncode(stringToSign)).digest('base64');
}

/**
 * Creates a broker adapter for the Webull OpenAPI.
 *
 * @param {object} opts
 * @param {string} opts.appKey - App key from the Webull developer portal.
 * @param {string} opts.appSecret - App secret from the Webull developer portal.
 * @param {string} [opts.apiHost] - API host override (defaults to Webull TH; point at the
 *   sandbox/UAT host from the portal for paper testing when one is issued).
 * @param {string} [opts.accountId] - Account to trade. Required when the app key can see
 *   more than one account; validated against /openapi/account/list at init.
 * @param {(url: string, opts?: object) => Promise<Response>} [opts.fetchImpl] - Override for
 *   the underlying fetch (tests inject a scripted fetch).
 * @param {Console} [opts.logger] - Logger for non-fatal warnings.
 * @param {() => Date} [opts.clock] - Timestamp source (tests pin it).
 * @param {() => string} [opts.nonce] - Nonce source (tests pin it).
 * @returns {object} broker - see `src/broker/broker.js` for the interface surface.
 */
export function createWebullBroker({
  appKey,
  appSecret,
  apiHost = DefaultWebullHost,
  accountId: configuredAccountId,
  fetchImpl = fetch,
  logger = console,
  clock = () => new Date(),
  nonce = randomUUID,
}) {
  // Accept a pasted URL for the host override, but sign with the bare host.
  const host = apiHost.replace(/^https?:\/\//, '').replace(/\/$/, '');
  let accountId = null;

  async function call(path, { method = 'GET', query, body, headers = {} } = {}) {
    const timestamp = isoSeconds(clock());
    const requestNonce = nonce();
    const signature = signWebullRequest({
      appKey, appSecret, host, path, query, body, timestamp, nonce: requestNonce,
    });
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    const res = await fetchImpl(`https://${host}${path}${qs}`, {
      method,
      headers: {
        'x-app-key': appKey,
        'x-timestamp': timestamp,
        'x-signature-version': '1.0',
        'x-signature-algorithm': 'HMAC-SHA256',
        'x-signature-nonce': requestNonce,
        'x-signature': signature,
        'x-version': ApiVersion,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      // Webull errors carry a JSON {code, msg}; quote it so rejections are
      // diagnosable from the intent's error column.
      const detail = await res.text().catch(() => '');
      const err = new Error(`Webull ${method} ${path} -> ${res.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function listAccounts() {
    return call('/openapi/account/list').then((accounts) => accounts ?? []);
  }

  async function init() {
    if (accountId) return { accountId };
    const accounts = await listAccounts();
    if (accounts.length === 0) throw new Error('Webull: no accounts visible to this app key');
    let account;
    if (configuredAccountId) {
      account = accounts.find((a) => String(a.account_id) === String(configuredAccountId));
      if (!account) throw new Error(`Webull: account ${configuredAccountId} not in account list`);
    } else if (accounts.length === 1) {
      account = accounts[0];
    } else {
      throw new Error('Webull: multiple accounts visible; set accountId on the broker connection');
    }
    accountId = String(account.account_id);
    return { accountId };
  }

  return {
    init,
    listAccounts,

    async isAuthenticated() {
      try {
        await init();
        return true;
      } catch {
        return false;
      }
    },

    async getAccountSummary() {
      await init();
      const s = await call('/openapi/assets/balance', {
        query: { account_id: accountId, total_asset_currency: 'USD' },
      });
      const cash = Number(s?.total_cash_balance ?? 0);
      // Net liquidation is region-dependent; fall back to marks + cash.
      const equity = s?.total_net_liquidation_value != null
        ? Number(s.total_net_liquidation_value)
        : Number(s?.total_market_value ?? 0) + cash;
      return { accountId, equity, cash };
    },

    async getPositions() {
      await init();
      const rows = await call('/openapi/assets/positions', { query: { account_id: accountId } });
      return (rows ?? [])
        .filter((p) => Number(p.quantity) !== 0)
        .map((p) => ({
          symbol: p.symbol,
          qty: Number(p.quantity),
          avgCost: Number(p.cost_price ?? 0),
          instrumentType: p.instrument_type,
        }));
    },

    async placeOrder({ symbol, side, qty, clientOrderId }) {
      await init();
      const resp = await call('/openapi/trade/order/place', {
        method: 'POST',
        headers: { category: OrderCategory },
        body: {
          account_id: accountId,
          new_orders: [{
            client_order_id: `${ClientOrderIdPrefix}${clientOrderId}`,
            combo_type: 'NORMAL',
            symbol,
            instrument_type: 'EQUITY',
            market: Market,
            order_type: 'MARKET',
            quantity: String(qty),
            side,
            time_in_force: 'DAY',
            entrust_type: 'QTY',
            support_trading_session: 'CORE',
          }],
        },
      });
      const orderId = resp?.order_id ?? resp?.orders?.[0]?.order_id;
      if (!orderId) throw new Error(`Webull: unexpected order response ${JSON.stringify(resp)}`);
      return { brokerOrderId: String(orderId) };
    },

    async getOrderStatus(clientOrderId) {
      await init();
      let o;
      try {
        o = await call('/openapi/trade/order/detail', {
          query: { account_id: accountId, client_order_id: `${ClientOrderIdPrefix}${clientOrderId}` },
        });
      } catch (err) {
        if (err.status === 404) return { found: false };
        throw err;
      }
      // Detail responses are combo-shaped: {client_order_id, combo_type,
      // orders: [...]}; a NORMAL (single-leg) order is orders[0].
      const detail = Array.isArray(o?.orders) ? o.orders[0] : o;
      const rawStatus = String(detail?.status ?? '');
      if (!rawStatus) return { found: false };
      let status = StatusMap[rawStatus.toLowerCase()];
      if (!status) {
        // Unmapped statuses stay 'submitted' (the safe, retry-friendly default)
        // but are logged so terminal-but-unmapped states don't pass silently.
        logger.warn?.(`[webull] unmapped order status "${rawStatus}" for ${clientOrderId}; treating as submitted`);
        status = 'submitted';
      }
      return {
        found: true,
        status,
        brokerOrderId: detail.order_id != null ? String(detail.order_id) : null,
        fillQty: Number(detail.filled_quantity ?? 0),
        avgFillPrice: Number(detail.filled_price ?? 0),
      };
    },
  };
}
