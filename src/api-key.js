'use strict';

/**
 * Génération et hachage des clés API des applications branchées (Task 5).
 *
 * Une clé API est générée UNE fois et montrée UNE fois à l'application ; rs-connector n'en
 * stocke JAMAIS la version en clair, uniquement son hash SHA-256 (comparaison par hash à
 * l'authentification) et un préfixe court non secret servant à l'identifier dans le
 * back-office.
 *
 * Format : "dk_" + 32 octets aléatoires en base64url  (dk = rs-connector key).
 */

const crypto = require('node:crypto');

const API_KEY_PREFIX = 'dk_';
// Longueur du préfixe visible conservé en base pour identifier une clé sans la révéler.
const VISIBLE_PREFIX_LENGTH = 12;

/** Hash SHA-256 (hex) d'une clé API. Déterministe. Ne renvoie jamais la clé en clair. */
function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey)).digest('hex');
}

/**
 * Génère une nouvelle clé API.
 * @returns {{ apiKey: string, prefix: string, hash: string }}
 *   - apiKey : la clé en clair (à montrer UNE fois à l'app, jamais stockée telle quelle)
 *   - prefix : préfixe visible non secret (identification en back-office)
 *   - hash   : hash SHA-256 à stocker en base
 */
function generateApiKey() {
  const secret = crypto.randomBytes(32).toString('base64url');
  const apiKey = `${API_KEY_PREFIX}${secret}`;
  return {
    apiKey,
    prefix: apiKey.slice(0, VISIBLE_PREFIX_LENGTH),
    hash: hashApiKey(apiKey),
  };
}

/** Génère un secret HMAC de webhook pour une application (révélé une fois, stocké tel quel). */
function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(32).toString('base64url')}`;
}

module.exports = { generateApiKey, hashApiKey, generateWebhookSecret, API_KEY_PREFIX, VISIBLE_PREFIX_LENGTH };
