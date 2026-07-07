'use strict';

/**
 * Accès à la base Postgres dédiée au gateway (Task 3). Le pool `pg` est injecté pour
 * permettre les tests avec un mock (aucune vraie connexion réseau en test unitaire) ;
 * les tests d'intégration réels utilisent un vrai pool contre une base de test.
 */

function createDb(pool) {
  async function init(schemaSql) {
    await pool.query(schemaSql);
  }

  async function upsertConnection({ connectionId, channelType = null, phoneNumber = null, status, qrCode = null, webhookUrl, applicationId, credentialsEncrypted }) {
    const result = await pool.query(
      `INSERT INTO connections (connection_id, phone_number, status, qr_code, webhook_url, channel_type, application_id, credentials_encrypted, updated_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'whatsapp_baileys'), $7, $8, now())
       ON CONFLICT (connection_id) DO UPDATE SET
         phone_number = COALESCE(EXCLUDED.phone_number, connections.phone_number),
         status = EXCLUDED.status,
         qr_code = EXCLUDED.qr_code,
         webhook_url = COALESCE(EXCLUDED.webhook_url, connections.webhook_url),
         channel_type = COALESCE($6, connections.channel_type),
         application_id = COALESCE(EXCLUDED.application_id, connections.application_id),
         credentials_encrypted = COALESCE(EXCLUDED.credentials_encrypted, connections.credentials_encrypted),
         last_connected_at = CASE WHEN EXCLUDED.status = 'connected' THEN now() ELSE connections.last_connected_at END,
         updated_at = now()
       RETURNING *`,
      [connectionId, phoneNumber, status, qrCode, webhookUrl ?? null, channelType, applicationId ?? null, credentialsEncrypted ?? null],
    );
    return result.rows[0];
  }

  // ---- Applications (multi-app, Task 5). Chaque application branchée a une clé API
  // (stockée uniquement hashée), une URL webhook et un secret HMAC propres. ----
  async function createApplication({ name, apiKeyHash, apiKeyPrefix, webhookUrl = null, webhookSecret = null, status = 'active' }) {
    const result = await pool.query(
      `INSERT INTO applications (name, api_key_hash, api_key_prefix, webhook_url, webhook_secret, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, apiKeyHash, apiKeyPrefix, webhookUrl, webhookSecret, status],
    );
    return result.rows[0];
  }

  async function getApplicationByApiKeyHash(apiKeyHash) {
    const result = await pool.query('SELECT * FROM applications WHERE api_key_hash = $1', [apiKeyHash]);
    return result.rows[0] || null;
  }

  async function getApplicationById(id) {
    const result = await pool.query('SELECT * FROM applications WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  // Canal par défaut de l'application (repli /v1/messages). connectionId peut être null (retrait).
  async function setApplicationDefaultConnection(id, connectionId) {
    const result = await pool.query(
      'UPDATE applications SET default_connection_id = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, connectionId],
    );
    return result.rows[0] || null;
  }

  // Réassignation de l'application d'une connexion (DB UNIQUEMENT — ne touche PAS la
  // session live, contrairement à upsertConnection/POST /connections). `applicationId`
  // peut être null pour détacher la connexion de toute application.
  async function setConnectionApplication(connectionId, applicationId) {
    const result = await pool.query(
      'UPDATE connections SET application_id = $2, updated_at = now() WHERE connection_id = $1 RETURNING *',
      [connectionId, applicationId],
    );
    return result.rows[0] || null;
  }

  // Régénération de la clé API d'une application : remplace le hash + le préfixe (l'ancienne
  // clé devient invalide immédiatement). La clé en clair n'est jamais stockée.
  async function updateApplicationApiKey(id, { apiKeyHash, apiKeyPrefix }) {
    const result = await pool.query(
      'UPDATE applications SET api_key_hash = $2, api_key_prefix = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [id, apiKeyHash, apiKeyPrefix],
    );
    return result.rows[0] || null;
  }

  async function deleteApplication(id) {
    const result = await pool.query('DELETE FROM applications WHERE id = $1 RETURNING id', [id]);
    return result.rowCount > 0;
  }

  async function updateApplicationWebhookSecret(id, { webhookSecret }) {
    const result = await pool.query(
      'UPDATE applications SET webhook_secret = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, webhookSecret],
    );
    return result.rows[0] || null;
  }

  // Cibles de webhook par connexion, avec le secret HMAC de l'application propriétaire.
  // (URL : celle de la connexion, sinon celle de l'application ; secret : celui de l'app.)
  async function listConnectionWebhookTargets() {
    const result = await pool.query(
      `SELECT c.connection_id, COALESCE(c.webhook_url, a.webhook_url) AS webhook_url, a.webhook_secret
       FROM connections c LEFT JOIN applications a ON a.id = c.application_id`,
    );
    return result.rows;
  }

  async function listApplications() {
    const result = await pool.query(
      'SELECT id, name, api_key_prefix, webhook_url, status, default_connection_id, created_at, updated_at FROM applications ORDER BY created_at ASC',
    );
    return result.rows;
  }

  // Scoping : une application ne voit et n'agit que sur SES connexions.
  async function listConnectionsByApplication(applicationId) {
    const result = await pool.query(
      'SELECT * FROM connections WHERE application_id = $1 ORDER BY created_at ASC',
      [applicationId],
    );
    return result.rows;
  }

  async function getConnectionForApplication(applicationId, connectionId) {
    const result = await pool.query(
      'SELECT * FROM connections WHERE application_id = $1 AND connection_id = $2',
      [applicationId, connectionId],
    );
    return result.rows[0] || null;
  }

  async function getConnection(connectionId) {
    const result = await pool.query('SELECT * FROM connections WHERE connection_id = $1', [connectionId]);
    return result.rows[0] || null;
  }

  async function listConnections() {
    const result = await pool.query('SELECT * FROM connections ORDER BY created_at ASC');
    return result.rows;
  }

  async function deleteConnection(connectionId) {
    await pool.query('DELETE FROM connections WHERE connection_id = $1', [connectionId]);
  }

  async function recordMessageStatus({ connectionId, messageId, status }) {
    const result = await pool.query(
      `INSERT INTO messages_status (connection_id, message_id, status)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [connectionId, messageId, status],
    );
    return result.rows[0];
  }

  async function getMessageStatusHistory(messageId) {
    const result = await pool.query(
      'SELECT * FROM messages_status WHERE message_id = $1 ORDER BY occurred_at ASC',
      [messageId],
    );
    return result.rows;
  }

  // Correctif post-relecture critique : cache persistant du mapping LID->numéro réel,
  // alimenté par le contact-resolver (Task 5) pour éviter de relire les fichiers d'auth
  // Baileys à chaque envoi, et par la réception d'un message entrant (messages.upsert
  // fournit souvent le LID réel de l'expéditeur).
  async function upsertContact({ connectionId, lid, phoneNumber }) {
    const result = await pool.query(
      `INSERT INTO contacts (connection_id, lid, phone_number, resolved_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (connection_id, lid) DO UPDATE SET
         phone_number = EXCLUDED.phone_number,
         resolved_at = now()
       RETURNING *`,
      [connectionId, lid, phoneNumber],
    );
    return result.rows[0];
  }

  async function getContact(connectionId, lid) {
    const result = await pool.query(
      'SELECT * FROM contacts WHERE connection_id = $1 AND lid = $2',
      [connectionId, lid],
    );
    return result.rows[0] || null;
  }

  // Correctif post-relecture critique : les transitions invalides ne sont plus
  // seulement loggées (logger.warn) mais persistées ici, dans un état consultable.
  async function recordStatusAnomaly({ connectionId, messageId, fromStatus, attemptedStatus, reason }) {
    const result = await pool.query(
      `INSERT INTO message_status_anomalies (connection_id, message_id, from_status, attempted_status, reason)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [connectionId, messageId, fromStatus, attemptedStatus, reason],
    );
    return result.rows[0];
  }

  async function getStatusAnomalies(messageId) {
    const result = await pool.query(
      'SELECT * FROM message_status_anomalies WHERE message_id = $1 ORDER BY occurred_at ASC',
      [messageId],
    );
    return result.rows;
  }

  async function listRecentStatusAnomalies(limit = 50) {
    const result = await pool.query(
      'SELECT * FROM message_status_anomalies ORDER BY occurred_at DESC LIMIT $1',
      [limit],
    );
    return result.rows;
  }

  // Task 6 : outbox persistante des webhooks sortants. `enqueueWebhook` écrit TOUJOURS
  // en DB avant qu'un envoi HTTP ne soit tenté (voir webhook-dispatcher.js) — c'est la
  // garantie anti-perte en cas de crash pendant un backoff.
  async function enqueueWebhook({ connectionId, eventType, payload }) {
    const result = await pool.query(
      `INSERT INTO outbox_webhooks (connection_id, event_type, payload, status, next_retry_at)
       VALUES ($1, $2, $3, 'pending', now())
       RETURNING *`,
      [connectionId, eventType, JSON.stringify(payload)],
    );
    return result.rows[0];
  }

  /**
   * Retourne les webhooks à (re)tenter : statut `pending`, dont l'échéance de retry est
   * passée. Ne retourne jamais `failed_permanent` (abandon définitif, diagnostic manuel).
   */
  async function getPendingWebhooks(limit = 50) {
    const result = await pool.query(
      `SELECT * FROM outbox_webhooks
       WHERE status = 'pending' AND next_retry_at <= now()
       ORDER BY next_retry_at ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async function markWebhookSent(id) {
    const result = await pool.query(
      `UPDATE outbox_webhooks SET status = 'sent', updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    return result.rows[0];
  }

  /**
   * Incrémente le compteur de tentatives et planifie soit un nouveau retry (backoff
   * exponentiel appliqué par l'appelant via `nextRetryAt`), soit bascule en
   * `failed_permanent` si `permanent` est vrai (seuil de tentatives atteint).
   */
  async function markWebhookFailed(id, { reason, nextRetryAt = null, permanent = false }) {
    const result = await pool.query(
      `UPDATE outbox_webhooks SET
         status = $2,
         attempts = attempts + 1,
         next_retry_at = COALESCE($3, next_retry_at),
         last_error = $4,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, permanent ? 'failed_permanent' : 'pending', nextRetryAt, reason],
    );
    return result.rows[0];
  }

  async function getWebhook(id) {
    const result = await pool.query('SELECT * FROM outbox_webhooks WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async function listWebhooksByConnection(connectionId, limit = 50) {
    const result = await pool.query(
      'SELECT * FROM outbox_webhooks WHERE connection_id = $1 ORDER BY created_at DESC LIMIT $2',
      [connectionId, limit],
    );
    return result.rows;
  }

  // ---- Back-office (Task 9) : comptes admin, sessions, tentatives de login. ----
  async function createAdminUser({ username, passwordHash, totpSecret = null, totpEnabled = false }) {
    const result = await pool.query(
      `INSERT INTO admin_users (username, password_hash, totp_secret, totp_enabled)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [username, passwordHash, totpSecret, totpEnabled],
    );
    return result.rows[0];
  }

  async function getAdminUserByUsername(username) {
    const result = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
    return result.rows[0] || null;
  }

  async function getAdminUserById(id) {
    const result = await pool.query('SELECT * FROM admin_users WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async function setAdminTotp(id, { totpSecret, totpEnabled }) {
    const result = await pool.query(
      'UPDATE admin_users SET totp_secret = $2, totp_enabled = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [id, totpSecret, totpEnabled],
    );
    return result.rows[0];
  }

  async function updateAdminPassword(id, passwordHash) {
    const result = await pool.query(
      'UPDATE admin_users SET password_hash = $2, updated_at = now() WHERE id = $1 RETURNING id',
      [id, passwordHash],
    );
    return result.rows[0] || null;
  }

  async function createAdminSession({ tokenHash, adminUserId, csrfToken, otpVerified, expiresAt }) {
    const result = await pool.query(
      `INSERT INTO admin_sessions (id, admin_user_id, csrf_token, otp_verified, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tokenHash, adminUserId, csrfToken, otpVerified, expiresAt],
    );
    return result.rows[0];
  }

  async function getAdminSession(tokenHash) {
    const result = await pool.query('SELECT * FROM admin_sessions WHERE id = $1', [tokenHash]);
    return result.rows[0] || null;
  }

  async function markAdminSessionOtpVerified(tokenHash) {
    await pool.query('UPDATE admin_sessions SET otp_verified = true WHERE id = $1', [tokenHash]);
  }

  async function deleteAdminSession(tokenHash) {
    await pool.query('DELETE FROM admin_sessions WHERE id = $1', [tokenHash]);
  }

  async function deleteExpiredAdminSessions() {
    await pool.query('DELETE FROM admin_sessions WHERE expires_at < now()');
  }

  async function getLoginAttempt(username) {
    const result = await pool.query('SELECT * FROM login_attempts WHERE username = $1', [username]);
    return result.rows[0] || null;
  }

  async function recordFailedLogin(username, { failedCount, lockedUntil = null }) {
    await pool.query(
      `INSERT INTO login_attempts (username, failed_count, locked_until, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (username) DO UPDATE SET failed_count = $2, locked_until = $3, updated_at = now()`,
      [username, failedCount, lockedUntil],
    );
  }

  async function resetLoginAttempts(username) {
    await pool.query('DELETE FROM login_attempts WHERE username = $1', [username]);
  }

  async function close() {
    await pool.end();
  }

  return {
    init,
    upsertConnection,
    getConnection,
    listConnections,
    deleteConnection,
    createApplication,
    updateApplicationApiKey,
    deleteApplication,
    updateApplicationWebhookSecret,
    listConnectionWebhookTargets,
    getApplicationByApiKeyHash,
    getApplicationById,
    setApplicationDefaultConnection,
    setConnectionApplication,
    listApplications,
    listConnectionsByApplication,
    getConnectionForApplication,
    recordMessageStatus,
    getMessageStatusHistory,
    upsertContact,
    getContact,
    recordStatusAnomaly,
    getStatusAnomalies,
    listRecentStatusAnomalies,
    enqueueWebhook,
    getPendingWebhooks,
    markWebhookSent,
    markWebhookFailed,
    getWebhook,
    listWebhooksByConnection,
    createAdminUser,
    getAdminUserByUsername,
    getAdminUserById,
    setAdminTotp,
    updateAdminPassword,
    createAdminSession,
    getAdminSession,
    markAdminSessionOtpVerified,
    deleteAdminSession,
    deleteExpiredAdminSessions,
    getLoginAttempt,
    recordFailedLogin,
    resetLoginAttempts,
    close,
  };
}

module.exports = { createDb };
