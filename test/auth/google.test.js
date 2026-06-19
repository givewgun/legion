import { describe, it, expect, vi } from 'vitest';
import { createGoogleAuth } from '../../src/auth/google.js';

function fakeClient(payload) {
  return {
    generateAuthUrl: vi.fn(({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    getToken: vi.fn(async () => ({ tokens: { id_token: 'idtok' } })),
    verifyIdToken: vi.fn(async () => ({ getPayload: () => payload })),
  };
}

describe('createGoogleAuth', () => {
  it('builds a consent URL carrying the state param', () => {
    const auth = createGoogleAuth({ clientId: 'id', clientSecret: 's', redirectUri: 'r', client: fakeClient({}) });
    expect(auth.authUrl('xyz')).toContain('state=xyz');
  });

  it('exchanges a code into a normalized profile', async () => {
    const client = fakeClient({ sub: 'g1', email: 'a@b.com', name: 'A', picture: 'pic' });
    const auth = createGoogleAuth({ clientId: 'id', clientSecret: 's', redirectUri: 'r', client });
    const profile = await auth.exchange('code123');
    expect(profile).toEqual({ googleSub: 'g1', email: 'a@b.com', name: 'A', avatarUrl: 'pic' });
    expect(client.getToken).toHaveBeenCalledWith('code123');
    expect(client.verifyIdToken).toHaveBeenCalledWith({ idToken: 'idtok', audience: 'id' });
  });

  it('throws when the id token has no email', async () => {
    const auth = createGoogleAuth({ clientId: 'id', clientSecret: 's', redirectUri: 'r', client: fakeClient({ sub: 'g1' }) });
    await expect(auth.exchange('c')).rejects.toThrow(/email/i);
  });
});
