'use strict';

/**
 * Authentification des COMPTES UTILISATEURS self-service (distincte du back-office admin).
 * Réutilise les primitives de cookie/session de l'admin (token aléatoire, seul le SHA-256
 * est stocké ; cookie httpOnly + SameSite=Strict ; CSRF sur les mutations). Cookie dédié
 * `rsconnector_user` pour ne pas interférer avec la session admin.
 */

const { hashToken, parseCookies } = require('../admin/auth-admin');

const USER_COOKIE = 'rsconnector_user';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function loadUserSession(db, req) {
  const token = parseCookies(req)[USER_COOKIE];
  if (!token) return null;
  const session = await db.getUserSession(hashToken(token));
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await db.deleteUserSession(session.id).catch(() => {});
    return null;
  }
  return session;
}

// Middleware : exige une session utilisateur valide + jeton CSRF sur les mutations.
function createRequireUser(db) {
  return async function requireUser(req, res, next) {
    try {
      const session = await loadUserSession(db, req);
      if (!session) return res.status(401).json({ error: 'unauthorized' });
      if (MUTATING_METHODS.has(req.method)) {
        const csrf = req.headers['x-csrf-token'];
        if (!csrf || csrf !== session.csrf_token) return res.status(403).json({ error: 'csrf_failed' });
      }
      const user = await db.getUserById(session.user_id);
      if (!user || user.status !== 'active') return res.status(401).json({ error: 'unauthorized' });
      req.user = user;
      req.userSession = session;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { USER_COOKIE, loadUserSession, createRequireUser };
