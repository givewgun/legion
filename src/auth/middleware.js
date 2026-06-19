// True only if `email` is on the allowlist (case-insensitive). An empty
// allowlist denies everyone — fail closed.
export function isAllowed(email, allowedEmails) {
  return allowedEmails.includes(email.trim().toLowerCase());
}

// Gate: requires a valid session pointing at an existing user. Sets req.user.
// 401s (never throws) so the SPA can show the login screen.
export function requireUser(repo) {
  return async (req, res, next) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'authentication required' });
      const user = await repo.getUserById(userId);
      if (!user) return res.status(401).json({ error: 'authentication required' });
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}
