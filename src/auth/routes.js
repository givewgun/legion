import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { isAllowed } from './middleware.js';

// Routes for the Google OAuth login flow. `google` is a createGoogleAuth
// result; `allowedEmails` gates who may create a session.
export function authRoutes({ google, repo, allowedEmails }) {
  const router = Router();

  router.get('/google', (req, res) => {
    const state = randomBytes(16).toString('hex');
    req.session.oauthState = state;
    res.redirect(google.authUrl(state));
  });

  router.get('/google/callback', async (req, res, next) => {
    try {
      const { code, state } = req.query;
      // CSRF: the state must match the one we stored before the redirect.
      if (!code || !state || state !== req.session.oauthState) {
        return res.status(403).json({ error: 'invalid oauth state' });
      }
      delete req.session.oauthState;
      const profile = await google.exchange(code);
      if (!isAllowed(profile.email, allowedEmails)) {
        return res.status(403).json({ error: 'not authorized' });
      }
      const user = await repo.upsertUser(profile);
      req.session.userId = user.id;
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('connect.sid');
      res.status(204).end();
    });
  });

  router.get('/me', (req, res, next) => {
    (async () => {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'authentication required' });
      const user = await repo.getUserById(userId);
      if (!user) return res.status(401).json({ error: 'authentication required' });
      res.json(user);
    })().catch(next);
  });

  return router;
}
