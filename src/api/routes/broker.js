// Broker-connection management (ADR 0036): CRUD + activate + test-connection
// for legion.broker_connections, the dashboard-managed replacement for env
// broker config. Secrets are write-only: requests carry them, responses never
// do (masked meta only). Auth-gated with the rest of /api by createApp.
import { Router } from 'express';
import { encryptCredentials, decryptCredentials } from '../../broker/credentials.js';
import { createBrokerFromConnection } from '../../broker/broker.js';

const Brokers = new Set(['ibkr', 'webull']);
// Per-broker credential fields: secret ones never leave the server; the rest
// echo back so the form can render current values.
const SecretFields = { ibkr: ['gatewayUrl'], webull: ['appKey', 'appSecret'] };
const PublicFields = { ibkr: [], webull: ['accountId', 'apiHost'] };
const RequiredFields = { ibkr: ['gatewayUrl'], webull: ['appKey', 'appSecret'] };

function mask(value) {
  const s = String(value);
  return s.length > 4 ? `••••${s.slice(-4)}` : '••••';
}

// Public view of a connection row: secret fields masked, decrypt failures
// surfaced as a flag (SESSION_SECRET rotated → re-enter credentials).
function present(conn, secret) {
  const out = {
    id: conn.id, name: conn.name, broker: conn.broker,
    paper: conn.paper, active: conn.active,
    createdAt: conn.createdAt, updatedAt: conn.updatedAt,
    credentials: {}, credentialsError: false,
  };
  try {
    const creds = decryptCredentials(conn.credentials, secret);
    for (const f of PublicFields[conn.broker] ?? []) out.credentials[f] = creds[f] ?? '';
    for (const f of SecretFields[conn.broker] ?? []) {
      out.credentials[f] = creds[f] ? mask(creds[f]) : '';
    }
  } catch {
    out.credentialsError = true;
  }
  return out;
}

// Validates + normalizes an incoming credentials body for a broker kind.
// `existing` (decrypted) fills fields the request leaves blank, so an edit that
// doesn't retype the secret keeps it.
function buildCredentials(broker, body, existing = {}) {
  const fields = [...(SecretFields[broker] ?? []), ...(PublicFields[broker] ?? [])];
  const creds = {};
  for (const f of fields) {
    const raw = body?.[f];
    const value = raw === undefined || raw === null || String(raw).trim() === '' ? existing[f] : String(raw).trim();
    if (value) creds[f] = value;
  }
  for (const f of RequiredFields[broker]) {
    if (!creds[f]) return { error: `${broker} connection requires credentials.${f}` };
  }
  return { creds };
}

export function brokerRoutes(repo, cfg = {}, brokerFactory = createBrokerFromConnection) {
  const router = Router();
  const secret = cfg.auth?.sessionSecret;

  router.get('/', async (req, res, next) => {
    try {
      const connections = await repo.listBrokerConnections();
      res.json({
        connections: connections.map((c) => present(c, secret)),
        allowLive: !!cfg.trading?.allowLive,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { name, broker, paper = true, credentials } = req.body ?? {};
      if (!Brokers.has(broker)) return res.status(400).json({ error: `unknown broker: ${broker}` });
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
      const built = buildCredentials(broker, credentials);
      if (built.error) return res.status(400).json({ error: built.error });
      const id = await repo.addBrokerConnection({
        name: String(name).trim(),
        broker,
        paper: paper !== false,
        credentials: encryptCredentials(built.creds, secret),
      });
      res.json({ connection: present(await repo.getBrokerConnection(id), secret) });
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const conn = await repo.getBrokerConnection(id);
      if (!conn) return res.status(404).json({ error: 'connection not found' });
      const { name, paper, credentials } = req.body ?? {};
      const patch = {};
      if (name !== undefined) {
        if (!String(name).trim()) return res.status(400).json({ error: 'name is required' });
        patch.name = String(name).trim();
      }
      if (paper !== undefined) patch.paper = paper !== false;
      if (credentials !== undefined) {
        // Blank secret fields mean "keep the stored value" — but if the stored
        // blob is unreadable (rotated SESSION_SECRET), the request must carry
        // full credentials.
        let existing = {};
        try {
          existing = decryptCredentials(conn.credentials, secret);
        } catch {
          existing = {};
        }
        const built = buildCredentials(conn.broker, credentials, existing);
        if (built.error) return res.status(400).json({ error: built.error });
        patch.credentials = encryptCredentials(built.creds, secret);
      }
      if (Object.keys(patch).length > 0) await repo.updateBrokerConnection(id, patch);
      res.json({ connection: present(await repo.getBrokerConnection(id), secret) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      await repo.deleteBrokerConnection(Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/activate', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const conn = await repo.getBrokerConnection(id);
      if (!conn) return res.status(404).json({ error: 'connection not found' });
      if (!conn.paper && !cfg.trading?.allowLive) {
        return res.status(400).json({
          error: 'live connection: set LEGION_ALLOW_LIVE_BROKER=true before activating',
        });
      }
      await repo.activateBrokerConnection(id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/deactivate', async (req, res, next) => {
    try {
      await repo.activateBrokerConnection(null);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Dry check of a stored connection: build its adapter, init (account
  // discovery + guards) and read the account summary. Failures come back as
  // 200 {ok:false} — a wrong app key is a result, not a server error. Webull
  // also returns the visible account list so the user can pick accountId.
  router.post('/:id/test', async (req, res, next) => {
    try {
      const conn = await repo.getBrokerConnection(Number(req.params.id));
      if (!conn) return res.status(404).json({ error: 'connection not found' });
      let accounts;
      try {
        const broker = brokerFactory(conn, {
          credentialsSecret: secret,
          allowLive: !!cfg.trading?.allowLive,
        });
        // Listed before init so "credentials valid, accountId not picked yet"
        // still hands the UI the choices instead of a bare error.
        if (broker.listAccounts) {
          accounts = (await broker.listAccounts()).map((a) => ({
            accountId: String(a.account_id),
            accountType: a.account_type ?? null,
            accountLabel: a.account_label ?? null,
          }));
        }
        const { accountId } = await broker.init();
        const summary = await broker.getAccountSummary();
        res.json({ ok: true, accountId, equity: summary.equity, cash: summary.cash, accounts });
      } catch (err) {
        res.json({ ok: false, error: err.message, accounts });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
