'use strict';

/**
 * TOTP (RFC 6238) pour la 2FA du back-office (Task 9), sans dépendance externe : HMAC-SHA1
 * via `crypto` natif + base32 (RFC 4648). Fournit aussi l'URI `otpauth://` (le QR est rendu
 * côté frontend à partir de cette URI).
 */

const crypto = require('node:crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Génère un secret TOTP en base32 (par défaut 20 octets d'entropie). */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** HOTP (RFC 4226) : code à `digits` chiffres pour un compteur donné. */
function hotp(secretBuf, counter, digits = DIGITS) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

/** Génère le code TOTP courant (paramétrable pour des tests déterministes). */
function generateTotp(secret, { now = Date.now(), step = STEP_SECONDS, digits = DIGITS } = {}) {
  const counter = Math.floor(now / 1000 / step);
  return hotp(base32Decode(secret), counter, digits);
}

/**
 * Vérifie un code TOTP en tolérant une fenêtre (±window pas de temps) pour la dérive
 * d'horloge. Comparaison en temps constant. Retourne false pour un token mal formé.
 */
function verifyTotp(secret, token, { now = Date.now(), step = STEP_SECONDS, window = 1, digits = DIGITS } = {}) {
  if (token == null) return false;
  const tokenStr = String(token).trim();
  if (!/^[0-9]+$/.test(tokenStr)) return false;
  const secretBuf = base32Decode(secret);
  const counter = Math.floor(now / 1000 / step);
  const tokenBuf = Buffer.from(tokenStr);
  for (let w = -window; w <= window; w += 1) {
    const code = hotp(secretBuf, counter + w, digits);
    const codeBuf = Buffer.from(code);
    if (codeBuf.length === tokenBuf.length && crypto.timingSafeEqual(codeBuf, tokenBuf)) {
      return true;
    }
  }
  return false;
}

/** Construit l'URI otpauth:// à encoder en QR côté frontend. */
function getOtpauthUri(secret, label, issuer) {
  const enc = encodeURIComponent;
  return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = {
  generateSecret,
  generateTotp,
  verifyTotp,
  getOtpauthUri,
  base32Encode,
  base32Decode,
  STEP_SECONDS,
  DIGITS,
};
