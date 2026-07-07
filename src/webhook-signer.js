'use strict';

/**
 * Signature HMAC-SHA256 des payloads de webhooks sortants (Task 6), même principe que
 * les webhooks Stripe/Cloud API déjà en place côté deskassit — copie du pattern, pas
 * de dépendance de code partagée.
 *
 * Le payload est sérialisé en JSON de façon déterministe (JSON.stringify sur l'objet
 * tel que fourni, sans réordonner les clés — l'appelant et le vérificateur doivent
 * utiliser exactement la même sérialisation) puis signé avec HMAC-SHA256. La signature
 * est transmise dans un header dédié (voir webhook-dispatcher.js), au format
 * "sha256=<hex>", pour rester explicite sur l'algorithme utilisé.
 */

/**
 * @param {object} deps
 * @param {object} deps.crypto - Module `crypto` (ou mock), injecté pour la testabilité.
 */
function createWebhookSigner(deps) {
  const { crypto } = deps;

  /**
   * Signe un payload avec le secret fourni. Retourne la signature au format
   * "sha256=<hex>", prête à être placée dans un header HTTP.
   *
   * @param {object|string} payload - Payload à signer (objet JSON ou chaîne déjà sérialisée).
   * @param {string} secret - Secret partagé HMAC.
   */
  function sign(payload, secret) {
    if (!secret) {
      throw new Error('Secret HMAC requis pour signer un webhook');
    }
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(serialized);
    return `sha256=${hmac.digest('hex')}`;
  }

  /**
   * Vérifie qu'une signature reçue correspond bien au payload et au secret attendus.
   * Utilise une comparaison à temps constant (timingSafeEqual) pour éviter les attaques
   * par mesure de temps sur la comparaison de signature.
   *
   * @param {object|string} payload
   * @param {string} secret
   * @param {string} signature - Signature reçue (format "sha256=<hex>").
   * @returns {boolean}
   */
  function verify(payload, secret, signature) {
    if (!signature || typeof signature !== 'string') return false;
    let expected;
    try {
      expected = sign(payload, secret);
    } catch {
      return false;
    }

    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signature);
    if (expectedBuf.length !== receivedBuf.length) return false;

    try {
      return crypto.timingSafeEqual(expectedBuf, receivedBuf);
    } catch {
      return false;
    }
  }

  return { sign, verify };
}

module.exports = { createWebhookSigner };
