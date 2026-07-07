'use strict';

/**
 * Hachage de mot de passe pour le back-office (Task 9), sans dépendance externe : utilise
 * `crypto.scrypt` natif de Node (KDF résistant au brute-force, recommandé). Évite `argon2`
 * (compilation native pénible sous Alpine/Docker) tout en restant robuste.
 *
 * Format stocké : `scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>`. Les paramètres sont
 * embarqués pour permettre une évolution future sans casser les hachages existants.
 */

const crypto = require('node:crypto');

const N = 16384; // coût CPU/mémoire (2^14)
const R = 8;
const P = 1;
const KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Vérifie un mot de passe contre un hash stocké, en temps constant. Retourne false (jamais
 * d'exception) si le format est invalide.
 */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(nStr), r: Number(rStr), p: Number(pStr),
    });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
