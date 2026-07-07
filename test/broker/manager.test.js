import { describe, it, expect, vi } from 'vitest';
import { encryptCredentials, decryptCredentials } from '../../src/broker/credentials.js';
import { createBrokerFromConnection } from '../../src/broker/broker.js';
import { createBrokerManager } from '../../src/broker/manager.js';

const Secret = 'session-secret';
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function connection(overrides = {}) {
  return {
    id: 1,
    name: 'Webull TH — paper',
    broker: 'webull',
    paper: true,
    active: true,
    credentials: encryptCredentials({ appKey: 'k', appSecret: 's' }, Secret),
    updatedAt: new Date('2026-07-07T00:00:00Z'),
    ...overrides,
  };
}

describe('credentials crypto', () => {
  it('round-trips a credentials object', () => {
    const creds = { appKey: 'k', appSecret: 's', accountId: 'ACC-1' };
    expect(decryptCredentials(encryptCredentials(creds, Secret), Secret)).toEqual(creds);
  });

  it('fails clearly on a rotated secret and on a malformed blob', () => {
    const blob = encryptCredentials({ a: 1 }, Secret);
    expect(() => decryptCredentials(blob, 'other-secret')).toThrow(/SESSION_SECRET/);
    expect(() => decryptCredentials('garbage', Secret)).toThrow(/malformed/);
  });

  it('requires a secret', () => {
    expect(() => encryptCredentials({}, '')).toThrow(/SESSION_SECRET/);
  });
});

describe('createBrokerFromConnection', () => {
  it('builds the adapter matching the connection kind', () => {
    const webull = createBrokerFromConnection(connection(), { credentialsSecret: Secret });
    expect(typeof webull.placeOrder).toBe('function');
    expect(typeof webull.listAccounts).toBe('function'); // webull-only surface

    const ibkr = createBrokerFromConnection(
      connection({ broker: 'ibkr', credentials: encryptCredentials({ gatewayUrl: 'https://ibeam:5000/v1/api' }, Secret) }),
      { credentialsSecret: Secret, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) },
    );
    expect(typeof ibkr.placeOrder).toBe('function');
    expect(ibkr.listAccounts).toBeUndefined();
  });

  it('returns null without a connection', () => {
    expect(createBrokerFromConnection(null, { credentialsSecret: Secret })).toBeNull();
  });

  it('refuses a live connection without the allowLive gate', () => {
    expect(() => createBrokerFromConnection(connection({ paper: false }), { credentialsSecret: Secret }))
      .toThrow(/LEGION_ALLOW_LIVE_BROKER/);
    expect(createBrokerFromConnection(connection({ paper: false }), { credentialsSecret: Secret, allowLive: true }))
      .toBeTruthy();
  });

  it('rejects missing required credentials and unknown kinds', () => {
    expect(() => createBrokerFromConnection(
      connection({ credentials: encryptCredentials({ appKey: 'k' }, Secret) }),
      { credentialsSecret: Secret },
    )).toThrow(/appKey\/appSecret/);
    expect(() => createBrokerFromConnection(
      connection({ broker: 'etrade' }),
      { credentialsSecret: Secret },
    )).toThrow(/unknown broker kind/);
  });
});

describe('broker manager', () => {
  function repoStub(conn) {
    return { getActiveBrokerConnection: vi.fn(async () => conn) };
  }

  it('returns nulls when no connection is active', async () => {
    const manager = createBrokerManager({ repo: repoStub(null), credentialsSecret: Secret, logger: silentLogger });
    expect(await manager.getBroker()).toEqual({ broker: null, connection: null });
  });

  it('caches the adapter until updated_at changes', async () => {
    const conn = connection();
    const repo = repoStub(conn);
    const manager = createBrokerManager({ repo, credentialsSecret: Secret, logger: silentLogger });
    const first = await manager.getBroker();
    const second = await manager.getBroker();
    expect(first.broker).toBe(second.broker); // same instance reused

    repo.getActiveBrokerConnection = async () => ({ ...conn, updatedAt: new Date('2026-07-07T01:00:00Z') });
    const third = await manager.getBroker();
    expect(third.broker).not.toBe(first.broker); // edit rebuilt the adapter
  });

  it('resolves {broker: null, connection} for a live row without allowLive, logging once', async () => {
    const errors = [];
    const manager = createBrokerManager({
      repo: repoStub(connection({ paper: false })),
      credentialsSecret: Secret,
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    });
    const first = await manager.getBroker();
    expect(first.broker).toBeNull();
    expect(first.connection).not.toBeNull();
    await manager.getBroker();
    expect(errors).toHaveLength(1); // cached failure, not one log per tick
  });

  it('serves the cached broker through a lookup blip', async () => {
    const repo = repoStub(connection());
    const manager = createBrokerManager({ repo, credentialsSecret: Secret, logger: silentLogger });
    const first = await manager.getBroker();
    repo.getActiveBrokerConnection = async () => { throw new Error('db blip'); };
    const second = await manager.getBroker();
    expect(second.broker).toBe(first.broker);
  });
});
