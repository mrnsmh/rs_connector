'use strict';

/**
 * Routeur SELF-SERVICE utilisateur (monté sur /u). Chaque utilisateur s'inscrit, se connecte,
 * puis crée/gère SES propres applications et canaux — strictement isolé des autres.
 * Réutilise les primitives d'auth (scrypt, sessions cookie + CSRF) et de clé API de l'admin.
 * Inspiré des flux d'inscription/connexion de deskassist & desklink.
 */

const crypto = require('node:crypto');
const express = require('express');
const logger = require('../logger');
const { hashPassword, verifyPassword } = require('../admin/password');
const { generateApiKey, generateWebhookSecret } = require('../api-key');
const { buildSessionCookie, clearSessionCookie, hashToken } = require('../admin/auth-admin');
const { USER_COOKIE, loadUserSession, createRequireUser } = require('./auth-user');

const MAX_FAILED_ATTEMPTS = 10;
const LOCK_MINUTES = 15;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function createUserRouter({ db, vault = null, connectionManager = null, adapterRegistry = null, mailer = null, publicBaseUrl = '', user = {} } = {}) {
  const router = express.Router();
  const sessionTtlSeconds = user.sessionTtlSeconds || 30 * 24 * 3600; // 30 jours
  const cookieSecure = user.cookieSecure !== false;
  const requireUser = createRequireUser(db);
  const newToken = () => crypto.randomBytes(32).toString('base64url');
  const setSession = (res, token) => res.setHeader('Set-Cookie', buildSessionCookie(token, { maxAgeSeconds: sessionTtlSeconds, secure: cookieSecure, cookieName: USER_COOKIE }));
  const norm = (e) => String(e || '').trim().toLowerCase();
  const throttleKey = (email) => `u:${email}`;
  const baseUrl = String(publicBaseUrl || '').replace(/\/+$/, '');
  const verifyLink = (token) => `${baseUrl}/u/verify?token=${encodeURIComponent(token)}`;

  async function openSession(res, userId) {
    const token = newToken();
    const csrfToken = newToken();
    await db.createUserSession({ tokenHash: hashToken(token), userId, csrfToken, expiresAt: new Date(Date.now() + sessionTtlSeconds * 1000) });
    setSession(res, token);
    return csrfToken;
  }

  // ==================== Authentification ====================
  router.post('/register', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'db_unavailable' });
    const email = norm(req.body && req.body.email);
    const password = (req.body && req.body.password) || '';
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email', message: 'Email invalide' });
    if (String(password).length < 8) return res.status(400).json({ error: 'weak_password', message: 'Mot de passe : 8 caractères minimum' });
    try {
      if (await db.getUserByEmail(email)) return res.status(409).json({ error: 'email_taken', message: 'Un compte existe déjà avec cet email' });
      const passwordHash = hashPassword(password);
      if (mailer) {
        // SMTP configuré → compte NON vérifié + email de confirmation. Aucune session tant que
        // l'email n'est pas confirmé (le login refusera un compte non vérifié).
        const token = newToken();
        const expires = new Date(Date.now() + 24 * 3600 * 1000);
        const u = await db.createUser({ email, passwordHash, emailVerified: false, verificationToken: token, verificationExpires: expires });
        try { await mailer.sendVerification(email, verifyLink(token)); }
        catch (mailErr) { logger.error({ err: mailErr.message }, 'Envoi email de vérification échoué'); }
        return res.status(201).json({ needsVerification: true, email: u.email });
      }
      // Pas de SMTP → auto-vérifié + session immédiate (dégradation gracieuse, ne bloque jamais).
      const u = await db.createUser({ email, passwordHash, emailVerified: true });
      const csrfToken = await openSession(res, u.id);
      return res.status(201).json({ email: u.email, csrfToken });
    } catch (err) {
      if (err && err.code === '23505') return res.status(409).json({ error: 'email_taken' });
      logger.error({ err: err.message }, 'Erreur register utilisateur');
      return res.status(500).json({ error: 'internal' });
    }
  });

  router.post('/login', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'db_unavailable' });
    const email = norm(req.body && req.body.email);
    const password = (req.body && req.body.password) || '';
    if (!email || !password) return res.status(400).json({ error: 'email et password requis' });
    try {
      const attempt = await db.getLoginAttempt(throttleKey(email));
      if (attempt && attempt.locked_until && new Date(attempt.locked_until).getTime() > Date.now()) {
        return res.status(429).json({ error: 'locked', message: 'Trop de tentatives, réessayez plus tard' });
      }
      const u = await db.getUserByEmail(email);
      const ok = !!u && u.status === 'active' && verifyPassword(password, u.password_hash);
      if (!ok) {
        const failedCount = (attempt ? attempt.failed_count : 0) + 1;
        const lockedUntil = failedCount >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
        await db.recordFailedLogin(throttleKey(email), { failedCount, lockedUntil });
        return res.status(401).json({ error: 'invalid_credentials' });
      }
      await db.resetLoginAttempts(throttleKey(email));
      if (!u.email_verified) return res.status(403).json({ error: 'email_not_verified', message: 'Confirmez votre email avant de vous connecter.' });
      const csrfToken = await openSession(res, u.id);
      return res.status(200).json({ email: u.email, csrfToken });
    } catch (err) {
      logger.error({ err: err.message }, 'Erreur login utilisateur');
      return res.status(500).json({ error: 'internal' });
    }
  });

  router.post('/logout', async (req, res) => {
    try {
      const session = await loadUserSession(db, req);
      if (session) await db.deleteUserSession(session.id);
    } catch { /* best effort */ }
    res.setHeader('Set-Cookie', clearSessionCookie({ secure: cookieSecure, cookieName: USER_COOKIE }));
    return res.status(200).json({ ok: true });
  });

  router.get('/me', requireUser, (req, res) => res.status(200).json({ email: req.user.email, csrfToken: req.userSession.csrf_token }));

  // Vérification d'email : lien cliqué depuis l'email (GET, non authentifié) → marque vérifié
  // puis redirige vers l'accueil avec un statut. Jetons expirables (24 h), à usage unique.
  router.get('/verify', async (req, res) => {
    const token = req.query && req.query.token;
    if (!token) return res.redirect(`${baseUrl}/?verify=missing`);
    try {
      const u = await db.getUserByVerificationToken(String(token));
      if (!u || (u.verification_expires && new Date(u.verification_expires).getTime() < Date.now())) {
        return res.redirect(`${baseUrl}/?verify=invalid`);
      }
      await db.markUserVerified(u.id);
      return res.redirect(`${baseUrl}/?verified=1`);
    } catch (err) {
      logger.error({ err: err.message }, 'Erreur vérification email');
      return res.redirect(`${baseUrl}/?verify=error`);
    }
  });

  // Renvoi de l'email de vérification. Réponse identique que le compte existe ou non
  // (pas d'énumération d'emails).
  router.post('/resend-verification', async (req, res) => {
    const email = norm(req.body && req.body.email);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
    try {
      const u = await db.getUserByEmail(email);
      if (u && !u.email_verified && mailer) {
        const token = newToken();
        await db.setVerificationToken(u.id, token, new Date(Date.now() + 24 * 3600 * 1000));
        try { await mailer.sendVerification(email, verifyLink(token)); } catch (e) { logger.error({ err: e.message }, 'Renvoi vérification échoué'); }
      }
      return res.status(200).json({ ok: true });
    } catch (err) { return res.status(500).json({ error: 'internal' }); }
  });

  // ==================== Applications (scopées à l'utilisateur) ====================
  router.get('/applications', requireUser, async (req, res) => {
    try { return res.status(200).json({ applications: await db.listApplicationsByUser(req.user.id) }); }
    catch (err) { logger.error({ err: err.message }, 'Erreur liste apps user'); return res.status(500).json({ error: 'internal' }); }
  });

  router.post('/applications', requireUser, async (req, res) => {
    const { name, webhookUrl = null } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name requis' });
    try {
      const { apiKey, prefix, hash } = generateApiKey();
      const webhookSecret = generateWebhookSecret();
      const app = await db.createApplication({ name, apiKeyHash: hash, apiKeyPrefix: prefix, webhookUrl, webhookSecret, userId: req.user.id });
      return res.status(201).json({ id: app.id, name: app.name, apiKey, apiKeyPrefix: prefix, webhookUrl: app.webhook_url, webhookSecret });
    } catch (err) { logger.error({ err: err.message }, 'Erreur création app user'); return res.status(500).json({ error: 'internal' }); }
  });

  router.post('/applications/:id/regenerate-key', requireUser, async (req, res) => {
    try {
      const app = await db.getApplicationByIdForUser(req.params.id, req.user.id);
      if (!app) return res.status(404).json({ error: 'not_found' });
      const { apiKey, prefix, hash } = generateApiKey();
      await db.updateApplicationApiKey(app.id, { apiKeyHash: hash, apiKeyPrefix: prefix });
      return res.status(200).json({ id: app.id, name: app.name, apiKey, apiKeyPrefix: prefix });
    } catch (err) { logger.error({ err: err.message }, 'Erreur regen clé user'); return res.status(500).json({ error: 'internal' }); }
  });

  router.post('/applications/:id/rotate-webhook-secret', requireUser, async (req, res) => {
    try {
      const app = await db.getApplicationByIdForUser(req.params.id, req.user.id);
      if (!app) return res.status(404).json({ error: 'not_found' });
      const webhookSecret = generateWebhookSecret();
      await db.updateApplicationWebhookSecret(app.id, { webhookSecret });
      return res.status(200).json({ id: app.id, name: app.name, webhookSecret });
    } catch (err) { logger.error({ err: err.message }, 'Erreur rotate secret user'); return res.status(500).json({ error: 'internal' }); }
  });

  router.delete('/applications/:id', requireUser, async (req, res) => {
    try {
      const app = await db.getApplicationByIdForUser(req.params.id, req.user.id);
      if (!app) return res.status(404).json({ error: 'not_found' });
      await db.deleteApplication(app.id);
      return res.status(200).json({ ok: true });
    } catch (err) { logger.error({ err: err.message }, 'Erreur suppression app user'); return res.status(500).json({ error: 'internal' }); }
  });

  // ==================== Canaux (connexions) scopés aux apps de l'utilisateur ====================
  // Vérifie qu'une connexion appartient bien à une application de l'utilisateur.
  async function ownedConnection(userId, connectionId) {
    const conn = await db.getConnection(connectionId);
    if (!conn || !conn.application_id) return null;
    const app = await db.getApplicationByIdForUser(conn.application_id, userId);
    return app ? conn : null;
  }

  router.get('/connections', requireUser, async (req, res) => {
    try {
      const apps = await db.listApplicationsByUser(req.user.id);
      const appIds = new Set(apps.map((a) => a.id));
      const live = connectionManager ? connectionManager.getAllStates() : {};
      const connexions = (await db.listConnections())
        .filter((r) => appIds.has(r.application_id))
        .map((r) => ({ connectionId: r.connection_id, channelType: r.channel_type, applicationId: r.application_id, status: r.status, hasCredentials: !!r.credentials_encrypted, state: live[r.connection_id] || null }));
      return res.status(200).json({ connexions });
    } catch (err) { logger.error({ err: err.message }, 'Erreur liste connexions user'); return res.status(500).json({ error: 'internal' }); }
  });

  router.post('/connections', requireUser, async (req, res) => {
    const { connectionId, channelType = 'whatsapp_baileys', applicationId, credentials = null, webhookUrl = null } = req.body || {};
    if (!connectionId || typeof connectionId !== 'string') return res.status(400).json({ error: 'bad_request', message: 'connectionId requis' });
    if (adapterRegistry && typeof adapterRegistry.getAdapter === 'function' && !adapterRegistry.getAdapter(channelType)) {
      return res.status(400).json({ error: 'unknown_channel_type' });
    }
    try {
      // L'application cible DOIT appartenir à l'utilisateur.
      const app = await db.getApplicationByIdForUser(applicationId, req.user.id);
      if (!app) return res.status(404).json({ error: 'application_not_found', message: 'Application inconnue ou non possédée' });
      // connectionId global : refus s'il appartient déjà à une AUTRE application.
      const existing = await db.getConnection(connectionId);
      if (existing && existing.application_id && existing.application_id !== app.id) {
        return res.status(409).json({ error: 'connection_conflict', message: 'connectionId déjà utilisé' });
      }
      const hasCreds = credentials && typeof credentials === 'object' && Object.keys(credentials).length > 0;
      let credentialsEncrypted;
      if (hasCreds) {
        if (!vault) return res.status(400).json({ error: 'encryption_not_configured', message: 'CREDENTIALS_ENCRYPTION_KEY requis' });
        credentialsEncrypted = vault.encryptJson(credentials);
      }
      await db.upsertConnection({ connectionId, channelType, applicationId: app.id, webhookUrl: webhookUrl || undefined, credentialsEncrypted, status: hasCreds ? 'initializing' : (existing ? existing.status : 'disconnected') });
      let state = null;
      if (hasCreds && connectionManager) {
        try {
          const adapter = await connectionManager.getOrCreate(connectionId, { channelType, credentials });
          if (adapter && typeof adapter.connect === 'function') await adapter.connect();
          state = adapter && typeof adapter.getState === 'function' ? adapter.getState() : null;
        } catch (connErr) {
          logger.error({ err: connErr.message, connectionId }, 'Connexion live user échouée');
          return res.status(502).json({ error: 'connect_failed', message: connErr.message, connectionId });
        }
      }
      return res.status(existing ? 200 : 201).json({ connectionId, channelType, applicationId: app.id, created: !existing, state });
    } catch (err) { logger.error({ err: err.message }, 'Erreur création connexion user'); return res.status(500).json({ error: 'internal' }); }
  });

  router.get('/connections/:connectionId/qr', requireUser, async (req, res) => {
    if (!connectionManager) return res.status(503).json({ error: 'connection_manager_unavailable' });
    if (!(await ownedConnection(req.user.id, req.params.connectionId))) return res.status(404).json({ error: 'not_found' });
    const adapter = connectionManager.get(req.params.connectionId);
    if (!adapter) return res.status(404).json({ error: 'connection_not_active' });
    return res.status(200).json(adapter.getState());
  });

  router.post('/connections/:connectionId/send', requireUser, async (req, res) => {
    if (!connectionManager) return res.status(503).json({ error: 'connection_manager_unavailable' });
    if (!(await ownedConnection(req.user.id, req.params.connectionId))) return res.status(404).json({ error: 'not_found' });
    const { to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'missing_fields' });
    const session = connectionManager.get(req.params.connectionId);
    if (!session || (typeof session.isConnected === 'function' && !session.isConnected())) return res.status(409).json({ error: 'connection_not_active' });
    try { const result = await session.sendMessage(to, text); return res.status(200).json({ ok: true, result }); }
    catch (err) { return res.status(500).json({ error: 'send_failed', message: err.message }); }
  });

  router.post('/connections/:connectionId/default', requireUser, async (req, res) => {
    const conn = await ownedConnection(req.user.id, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'not_found' });
    await db.setApplicationDefaultConnection(conn.application_id, conn.connection_id);
    return res.status(200).json({ ok: true, applicationId: conn.application_id, defaultConnectionId: conn.connection_id });
  });

  router.delete('/connections/:connectionId/default', requireUser, async (req, res) => {
    const conn = await ownedConnection(req.user.id, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'not_found' });
    const app = await db.getApplicationByIdForUser(conn.application_id, req.user.id);
    if (app && app.default_connection_id === conn.connection_id) await db.setApplicationDefaultConnection(conn.application_id, null);
    return res.status(200).json({ ok: true });
  });

  router.post('/connections/:connectionId/application', requireUser, async (req, res) => {
    const conn = await ownedConnection(req.user.id, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'not_found' });
    const target = (req.body && req.body.applicationId) || null;
    // Déplacement autorisé UNIQUEMENT vers une autre application de l'utilisateur.
    if (target) {
      const app = await db.getApplicationByIdForUser(target, req.user.id);
      if (!app) return res.status(404).json({ error: 'application_not_found' });
    }
    await db.setConnectionApplication(conn.connection_id, target);
    return res.status(200).json({ ok: true });
  });

  router.delete('/connections/:connectionId', requireUser, async (req, res) => {
    const conn = await ownedConnection(req.user.id, req.params.connectionId);
    if (!conn) return res.status(404).json({ error: 'not_found' });
    await db.deleteConnection(conn.connection_id);
    return res.status(200).json({ ok: true });
  });

  return router;
}

module.exports = { createUserRouter };
