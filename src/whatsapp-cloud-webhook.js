'use strict';

/**
 * Helpers du webhook WhatsApp Cloud API (Meta) — Task 8. Fonctions pures + crypto,
 * isolées et testables indépendamment des routes Express.
 */

const crypto = require('node:crypto');

/**
 * Vérifie la signature `X-Hub-Signature-256: sha256=<hex>` d'un webhook Meta : HMAC-SHA256
 * du corps BRUT (bytes exacts reçus) avec le secret de l'app Meta. Comparaison en temps
 * constant. Retourne false si secret/signature/corps manquants ou non concordants.
 *
 * @param {Buffer|string} rawBody - Corps brut de la requête (bytes exacts).
 * @param {string} signatureHeader - Valeur de l'en-tête X-Hub-Signature-256.
 * @param {string} appSecret - Secret de l'application Meta.
 */
function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || !signatureHeader || rawBody == null) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const provided = Buffer.from(String(signatureHeader));
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(provided, expectedBuf);
}

/**
 * Vérifie la requête GET de validation du webhook (Meta envoie hub.mode/hub.verify_token/
 * hub.challenge). Retourne { ok, challenge } : si ok, la route doit renvoyer challenge en 200.
 *
 * @param {object} query - req.query.
 * @param {string} expectedVerifyToken - Token de vérification configuré.
 */
function checkVerification(query, expectedVerifyToken) {
  const q = query || {};
  const mode = q['hub.mode'];
  const token = q['hub.verify_token'];
  const challenge = q['hub.challenge'];
  if (mode === 'subscribe' && expectedVerifyToken && token === expectedVerifyToken) {
    return { ok: true, challenge: String(challenge != null ? challenge : '') };
  }
  return { ok: false, challenge: null };
}

/**
 * Extrait les événements normalisés d'un payload webhook Meta. Chaque événement porte le
 * `phoneNumberId` (metadata) et l'objet `value` brut (à passer à adapter.ingestWebhook).
 *
 * Forme Meta : { object, entry: [ { id, changes: [ { field, value: { metadata:
 *   { phone_number_id }, messages: [...], statuses: [...] } } ] } ] }
 *
 * @returns {Array<{phoneNumberId: string|null, value: object}>}
 */
function extractInboundEvents(payload) {
  const events = [];
  if (!payload || !Array.isArray(payload.entry)) return events;
  for (const entry of payload.entry) {
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      const value = change && change.value;
      if (!value) continue;
      const phoneNumberId = value.metadata && value.metadata.phone_number_id != null
        ? String(value.metadata.phone_number_id)
        : null;
      events.push({ phoneNumberId, value });
    }
  }
  return events;
}

module.exports = { verifyMetaSignature, checkVerification, extractInboundEvents };
