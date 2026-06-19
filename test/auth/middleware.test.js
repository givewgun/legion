import { describe, it, expect, vi } from 'vitest';
import { isAllowed, requireUser } from '../../src/auth/middleware.js';

function res() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
}

describe('isAllowed', () => {
  it('matches case-insensitively', () => {
    expect(isAllowed('A@B.com', ['a@b.com'])).toBe(true);
    expect(isAllowed('x@y.com', ['a@b.com'])).toBe(false);
  });
  it('rejects everyone when the allowlist is empty', () => {
    expect(isAllowed('a@b.com', [])).toBe(false);
  });
});

describe('requireUser', () => {
  it('401s when there is no session user', async () => {
    const r = res();
    const next = vi.fn();
    await requireUser({ getUserById: vi.fn() })({ session: {} }, r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('sets req.user and calls next when the session is valid', async () => {
    const req = { session: { userId: 7 } };
    const next = vi.fn();
    const repo = { getUserById: vi.fn(async () => ({ id: 7, email: 'a@b.com' })) };
    await requireUser(repo)(req, res(), next);
    expect(req.user).toEqual({ id: 7, email: 'a@b.com' });
    expect(next).toHaveBeenCalled();
  });

  it('401s when the session points at a deleted user', async () => {
    const r = res();
    const next = vi.fn();
    await requireUser({ getUserById: vi.fn(async () => null) })({ session: { userId: 9 } }, r, next);
    expect(r.status).toHaveBeenCalledWith(401);
  });
});
