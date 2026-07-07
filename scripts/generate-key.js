'use strict';

/**
 * CLI : génère une clé de chiffrement AES-256-GCM (32 octets, base64) pour
 * CREDENTIALS_ENCRYPTION_KEY. À stocker hors de la base (secret d'environnement).
 *
 *   node scripts/generate-key.js
 */

const { generateKey } = require('../src/crypto-vault');

console.log(generateKey());
