import { OAuth2Client } from 'google-auth-library';

// Wraps Google's OAuth2 authorization-code flow. `client` is injectable so
// tests run without contacting Google; in prod it defaults to a real
// OAuth2Client built from the credentials.
export function createGoogleAuth({ clientId, clientSecret, redirectUri, client }) {
  const oauth = client ?? new OAuth2Client(clientId, clientSecret, redirectUri);

  return {
    // Consent URL. `state` is an unguessable token the caller stores in the
    // session and re-checks on callback (CSRF defense for the login flow).
    authUrl(state) {
      return oauth.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        state,
      });
    },

    // Exchange the callback code for tokens, verify the id token, return a
    // normalized profile. Throws if the token is invalid or lacks an email.
    async exchange(code) {
      const { tokens } = await oauth.getToken(code);
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload?.email) throw new Error('Google id token missing email');
      return {
        googleSub: payload.sub,
        email: payload.email,
        name: payload.name ?? null,
        avatarUrl: payload.picture ?? null,
      };
    },
  };
}
