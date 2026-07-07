// Broker abstraction (ADR 0035/0036). One instance-level account per deployment,
// resolved from the active row in legion.broker_connections (dashboard-managed,
// credentials encrypted in the DB — no broker env config). Adapters implement:
//   init() -> { accountId }
//   isAuthenticated() -> boolean (never throws)
//   getAccountSummary() -> { accountId, equity, cash }
//   getPositions() -> [{ symbol, qty, avgCost, ... }]
//   placeOrder({ symbol, side, qty, clientOrderId }) -> { brokerOrderId }
//   getOrderStatus(clientOrderId) -> { found, status: submitted|filled|cancelled, fillQty, avgFillPrice }
import { createIbkrBroker } from './ibkr.js';
import { createWebullBroker } from './webull.js';
import { decryptCredentials } from './credentials.js';

/**
 * Builds a broker adapter from a broker_connections row.
 *
 * @param {object} connection - Row from the repo (`credentials` is the encrypted blob).
 * @param {object} opts
 * @param {string} opts.credentialsSecret - SESSION_SECRET the credentials blob is keyed on.
 * @param {boolean} [opts.allowLive] - LEGION_ALLOW_LIVE_BROKER: without it a paper=false
 *   connection refuses to build (the one hard safety gate that stays in env).
 * @param {(url: string, opts?: object) => Promise<Response>} [opts.fetchImpl] - Override for
 *   the underlying fetch (tests inject a scripted fetch).
 * @param {Console} [opts.logger]
 * @returns {object|null} A broker instance, or `null` when no connection is given.
 */
export function createBrokerFromConnection(connection, { credentialsSecret, allowLive = false, fetchImpl, logger = console } = {}) {
  if (!connection) return null;
  if (!connection.paper && !allowLive) {
    throw new Error(
      `broker connection "${connection.name}" is live; set LEGION_ALLOW_LIVE_BROKER=true to trade it`,
    );
  }
  const creds = decryptCredentials(connection.credentials, credentialsSecret);
  switch (connection.broker) {
    case 'ibkr':
      if (!creds.gatewayUrl) throw new Error(`ibkr connection "${connection.name}" is missing gatewayUrl`);
      // A paper connection keeps the adapter's D-prefix assertion armed; a live
      // one (already past the allowLive gate above) disarms it.
      return createIbkrBroker({
        gatewayUrl: creds.gatewayUrl,
        allowLive: !connection.paper,
        fetchImpl,
        logger,
      });
    case 'webull':
      if (!creds.appKey || !creds.appSecret) {
        throw new Error(`webull connection "${connection.name}" is missing appKey/appSecret`);
      }
      return createWebullBroker({
        appKey: creds.appKey,
        appSecret: creds.appSecret,
        apiHost: creds.apiHost || undefined,
        accountId: creds.accountId || undefined,
        fetchImpl,
        logger,
      });
    default:
      throw new Error(`unknown broker kind "${connection.broker}"`);
  }
}
