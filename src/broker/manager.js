// Broker manager (ADR 0036): resolves the active legion.broker_connections row
// to a live adapter instance. Callers (executor tick, /api/portfolio request)
// ask per use; the instance is cached on (id, updated_at) so a dashboard edit or
// switch is picked up on the next tick without a restart, while an unchanged
// connection reuses the same adapter (and its account/conid caches).
import { createBrokerFromConnection } from './broker.js';

export function createBrokerManager({ repo, credentialsSecret, allowLive = false, fetchImpl, logger = console }) {
  let cached = null; // { key, broker, connection } — broker null when the row can't build

  return {
    /**
     * @returns {Promise<{broker: object|null, connection: object|null}>} The adapter for the
     *   active connection, or nulls when none is active. A connection that fails to build
     *   (live without LEGION_ALLOW_LIVE_BROKER, undecryptable credentials) returns
     *   `{ broker: null, connection }` — configured, but not tradable.
     */
    async getBroker() {
      let connection;
      try {
        connection = await repo.getActiveBrokerConnection();
      } catch (err) {
        logger.warn?.(`[broker] active connection lookup failed: ${err.message}`);
        return cached ? { broker: cached.broker, connection: cached.connection } : { broker: null, connection: null };
      }
      if (!connection) {
        cached = null;
        return { broker: null, connection: null };
      }
      const key = `${connection.id}:${new Date(connection.updatedAt).getTime()}`;
      if (cached?.key !== key) {
        let broker = null;
        try {
          broker = createBrokerFromConnection(connection, { credentialsSecret, allowLive, fetchImpl, logger });
        } catch (err) {
          // Cache the failure under the same key so a broken row logs once,
          // not once per 15s tick; any edit to the row retries.
          logger.error?.(`[broker] cannot build connection "${connection.name}" (${connection.broker}): ${err.message}`);
        }
        cached = { key, broker, connection };
      }
      return { broker: cached.broker, connection: cached.connection };
    },
  };
}
