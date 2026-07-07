import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { brokerRoutes } from '../../src/api/routes/broker.js';
import { encryptCredentials, decryptCredentials } from '../../src/broker/credentials.js';

const Secret = 'session-secret';
const cfg = { auth: { sessionSecret: Secret }, trading: { allowLive: false } };

// In-memory repo over a plain array — the routes only need CRUD semantics.
function repoStub(rows = []) {
  let nextId = rows.length + 1;
  return {
    rows,
    listBrokerConnections: async () => rows,
    getBrokerConnection: async (id) => rows.find((r) => r.id === id) ?? null,
    addBrokerConnection: async ({ name, broker, paper, credentials }) => {
      const id = nextId++;
      rows.push({ id, name, broker, paper, active: false, credentials, createdAt: new Date(), updatedAt: new Date() });
      return id;
    },
    updateBrokerConnection: async (id, patch) => {
      Object.assign(rows.find((r) => r.id === id), patch, { updatedAt: new Date() });
    },
    deleteBrokerConnection: async (id) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
    activateBrokerConnection: async (id) => {
      for (const r of rows) r.active = r.id === id;
    },
  };
}

function build(repo, brokerFactory) {
  const app = express();
  app.use(express.json());
  app.use('/api/broker', brokerRoutes(repo, cfg, brokerFactory));
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

const webullRow = (overrides = {}) => ({
  id: 1, name: 'Webull TH — paper', broker: 'webull', paper: true, active: false,
  credentials: encryptCredentials({ appKey: 'live-key-abcd', appSecret: 'sssh', accountId: 'ACC-1' }, Secret),
  createdAt: new Date(), updatedAt: new Date(),
  ...overrides,
});

describe('broker routes', () => {
  it('lists connections with secrets masked, never returned', async () => {
    const res = await request(build(repoStub([webullRow()]))).get('/api/broker');
    expect(res.status).toBe(200);
    const [conn] = res.body.connections;
    expect(conn.credentials.appKey).toBe('••••abcd');
    expect(conn.credentials.appSecret).toBe('••••');
    expect(conn.credentials.accountId).toBe('ACC-1');
    expect(JSON.stringify(res.body)).not.toContain('sssh');
    expect(res.body.allowLive).toBe(false);
  });

  it('flags a connection whose blob no longer decrypts', async () => {
    const row = webullRow({ credentials: encryptCredentials({ appKey: 'k', appSecret: 's' }, 'old-secret') });
    const res = await request(build(repoStub([row]))).get('/api/broker');
    expect(res.body.connections[0].credentialsError).toBe(true);
  });

  it('creates a webull connection, validating required credential fields', async () => {
    const repo = repoStub();
    const app = build(repo);
    const missing = await request(app).post('/api/broker').send({
      name: 'wb', broker: 'webull', credentials: { appKey: 'k' },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/appSecret/);

    const res = await request(app).post('/api/broker').send({
      name: 'wb', broker: 'webull', paper: true,
      credentials: { appKey: 'k', appSecret: 's', accountId: '', apiHost: '' },
    });
    expect(res.status).toBe(200);
    expect(decryptCredentials(repo.rows[0].credentials, Secret)).toEqual({ appKey: 'k', appSecret: 's' });
  });

  it('rejects unknown brokers and missing names', async () => {
    const app = build(repoStub());
    expect((await request(app).post('/api/broker').send({ name: 'x', broker: 'etrade', credentials: {} })).status).toBe(400);
    expect((await request(app).post('/api/broker').send({ broker: 'webull', credentials: { appKey: 'k', appSecret: 's' } })).status).toBe(400);
  });

  it('keeps stored secrets when an edit leaves them blank', async () => {
    const repo = repoStub([webullRow()]);
    const res = await request(build(repo)).put('/api/broker/1').send({
      name: 'renamed', credentials: { appKey: '', appSecret: '', accountId: 'ACC-2' },
    });
    expect(res.status).toBe(200);
    const stored = decryptCredentials(repo.rows[0].credentials, Secret);
    expect(stored).toEqual({ appKey: 'live-key-abcd', appSecret: 'sssh', accountId: 'ACC-2' });
    expect(repo.rows[0].name).toBe('renamed');
  });

  it('activates a paper connection; refuses a live one without the env gate', async () => {
    const repo = repoStub([webullRow(), webullRow({ id: 2, name: 'live', paper: false })]);
    const app = build(repo);
    expect((await request(app).post('/api/broker/1/activate')).status).toBe(200);
    expect(repo.rows[0].active).toBe(true);

    const live = await request(app).post('/api/broker/2/activate');
    expect(live.status).toBe(400);
    expect(live.body.error).toMatch(/LEGION_ALLOW_LIVE_BROKER/);

    expect((await request(app).post('/api/broker/deactivate')).status).toBe(200);
    expect(repo.rows.some((r) => r.active)).toBe(false);
  });

  it('test endpoint reports summary + accounts, and failures as ok:false', async () => {
    const factory = vi.fn(() => ({
      init: async () => ({ accountId: 'ACC-1' }),
      getAccountSummary: async () => ({ accountId: 'ACC-1', equity: 1000, cash: 400 }),
      listAccounts: async () => [{ account_id: 'ACC-1', account_type: 'CASH', account_label: 'Cash' }],
    }));
    const ok = await request(build(repoStub([webullRow()]), factory)).post('/api/broker/1/test');
    expect(ok.body).toEqual({
      ok: true, accountId: 'ACC-1', equity: 1000, cash: 400,
      accounts: [{ accountId: 'ACC-1', accountType: 'CASH', accountLabel: 'Cash' }],
    });

    const failing = vi.fn(() => ({
      init: async () => { throw new Error('invalid app key'); },
      listAccounts: async () => { throw new Error('invalid app key'); },
    }));
    const bad = await request(build(repoStub([webullRow()]), failing)).post('/api/broker/1/test');
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toMatch(/invalid app key/);
  });

  it('404s on unknown ids', async () => {
    const app = build(repoStub());
    expect((await request(app).put('/api/broker/9').send({ name: 'x' })).status).toBe(404);
    expect((await request(app).post('/api/broker/9/activate')).status).toBe(404);
    expect((await request(app).post('/api/broker/9/test')).status).toBe(404);
  });
});
