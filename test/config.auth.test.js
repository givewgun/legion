import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/index.js';

describe('auth config', () => {
  it('parses the allowlist into a trimmed lowercase array', () => {
    const cfg = loadConfig({
      LEGION_ALLOWED_EMAILS: 'A@B.com, c@d.com ',
      GOOGLE_OAUTH_CLIENT_ID: 'id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      SESSION_SECRET: 'shh',
      LEGION_PUBLIC_URL: 'https://legion.givewgun.com',
    });
    expect(cfg.auth.allowedEmails).toEqual(['a@b.com', 'c@d.com']);
    expect(cfg.auth.googleClientId).toBe('id');
    expect(cfg.auth.publicUrl).toBe('https://legion.givewgun.com');
  });

  it('defaults to an empty allowlist when unset', () => {
    expect(loadConfig({}).auth.allowedEmails).toEqual([]);
  });
});
