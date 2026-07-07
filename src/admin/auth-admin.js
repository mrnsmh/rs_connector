'use strict';

/**
 * Authentification du back-office (Task 9) : gestion des cookies de session (httpOnly),
 * chargement de session, et middleware exigeant une session pleinement authentifiée
 * (OTP vérifié) + protection CSRF sur les requêtes mutantes.
 *
 * Le cookie porte un token aléatoire ; la base ne stocke que son hash SHA-256 (une fuite
 * de la base ne révèle donc pas de token de session utilisable).
 */

const crypto = require('node:crypto');

const COOKIE_NAME = 'rsconnector_admin';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function parseCookies(req) {
  const header = (req.headers && req.headers.cookie) || '';
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function buildSessionCookie(token, { maxAgeSeconds, secure = true, cookieName = COOKIE_NAME }) {
  const parts = [
    `${cookieName}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie({ secure = true, cookieName = COOKIE_NAME } = {}) {
  const parts = [`${cookieName}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Charge la session admin depuis le cookie (ou null). Supprime et ignore une session
 * expirée. NE vérifie PAS l'OTP (utilisé aussi par l'étape OTP du login).
 */
async function loadAdminSession(db, req, cookieName = COOKIE_NAME) {
  const token = parseCookies(req)[cookieName];
  if (!token) return null;
  const session = await db.getAdminSession(hashToken(token));
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await db.deleteAdminSession(session.id).catch(() => {});
    return null;
  }
  return session;
}

/**
 * Middleware : exige une session admin pleinement authentifiée (OTP vérifié) et vérifie le
 * jeton CSRF (en-tête X-CSRF-Token) sur les requêtes mutantes. Renseigne req.adminUser /
 * req.adminSession.
 */
function createRequireAdmin(db, { cookieName = COOKIE_NAME } = {}) {
  return async function requireAdmin(req, res, next) {
    try {
      const session = await loadAdminSession(db, req, cookieName);
      if (!session) return res.status(401).json({ error: 'unauthorized' });
      if (!session.otp_verified) return res.status(403).json({ error: 'otp_required' });
      if (MUTATING_METHODS.has(req.method)) {
        const csrf = req.headers['x-csrf-token'];
        if (!csrf || csrf !== session.csrf_token) {
          return res.status(403).json({ error: 'csrf_failed' });
        }
      }
      const user = await db.getAdminUserById(session.admin_user_id);
      if (!user) return res.status(401).json({ error: 'unauthorized' });
      req.adminUser = user;
      req.adminSession = session;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = {
  COOKIE_NAME,
  hashToken,
  parseCookies,
  buildSessionCookie,
  clearSessionCookie,
  loadAdminSession,
  createRequireAdmin,
};
