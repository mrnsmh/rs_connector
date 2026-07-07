'use strict';

/**
 * Coffre de chiffrement des credentials au repos (Task 11) : AES-256-GCM avec clé injectée
 * (jamais stockée en base). Utilisé pour chiffrer les secrets de canal (token Telegram,
 * token Meta, mot de passe SMTP/IMAP…) et le secret TOTP admin avant persistance.
 *
 * Format du chiffré : `gcm1.<ivB64>.<tagB64>.<ciphertextB64>` (IV 12 o aléatoire, tag GCM
 * 16 o). L'authentification GCM garantit l'intégrité : toute altération fait échouer le
 * déchiffrement (throw), jamais de retour silencieux de données corrompues.
 *
 * La clé (32 octets) vient de l'environnement (`CREDENTIALS_ENCRYPTION_KEY`, base64 ou hex),
 * injectée via createVault() pour rester testable. Générer une clé :
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'gcm1';
const IV_BYTES = 12;

function normalizeKey(key) {
  if (Buffer.isBuffer(key)) {
    if (key.length !== 32) throw new Error('La clé de chiffrement doit faire 32 octets');
    return key;
  }
  if (typeof key === 'string' && key.length > 0) {
    for (const enc of ['base64', 'hex']) {
      try {
        const buf = Buffer.from(key, enc);
        if (buf.length === 32) return buf;
      } catch { /* essaie l'encodage suivant */ }
    }
  }
  throw new Error('CREDENTIALS_ENCRYPTION_KEY invalide : 32 octets attendus (base64 ou hex)');
}

/**
 * @param {string|Buffer} key - Clé de 32 octets (base64/hex si string).
 * @returns {{ encrypt, decrypt, encryptJson, decryptJson }}
 */
function createVault(key) {
  const keyBuf = normalizeKey(key);

  function encrypt(plaintext) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, keyBuf, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
  }

  function decrypt(payload) {
    const parts = String(payload).split('.');
    if (parts.length !== 4 || parts[0] !== PREFIX) {
      throw new Error('Format de chiffré invalide');
    }
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv(ALGORITHM, keyBuf, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  return {
    encrypt,
    decrypt,
    encryptJson: (obj) => encrypt(JSON.stringify(obj)),
    decryptJson: (payload) => JSON.parse(decrypt(payload)),
  };
}

/** Utilitaire : génère une clé de 32 octets en base64. */
function generateKey() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = { createVault, generateKey, PREFIX };
