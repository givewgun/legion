// Broker abstraction (ADR 0035). One instance-level account per deployment.
// v1 ships the IBKR Client Portal adapter; an InnovestX (Settrade) adapter is a
// future sibling implementing the same surface:
//   init() -> { accountId }
//   isAuthenticated() -> boolean (never throws)
//   getAccountSummary() -> { accountId, equity, cash }
//   getPositions() -> [{ symbol, qty, avgCost, conid }]
//   placeOrder({ symbol, side, qty, clientOrderId }) -> { brokerOrderId }
//   getOrderStatus(clientOrderId) -> { found, status: submitted|filled|cancelled, fillQty, avgFillPrice }
import { createIbkrBroker } from './ibkr.js';

/**
 * Builds a broker adapter from application config.
 *
 * @param {object} cfg - App config; expects `cfg.broker.gatewayUrl` (and optional `cfg.broker.allowLive`).
 * @param {(url: string, opts?: object) => Promise<Response>} [fetchImpl] - Override for the underlying fetch (tests inject a scripted fetch).
 * @returns {object|null} A broker instance, or `null` when no gateway is configured.
 */
export function createBrokerFromConfig(cfg, fetchImpl) {
  if (!cfg.broker?.gatewayUrl) return null;
  return createIbkrBroker({
    gatewayUrl: cfg.broker.gatewayUrl,
    allowLive: cfg.broker.allowLive,
    fetchImpl,
  });
}
