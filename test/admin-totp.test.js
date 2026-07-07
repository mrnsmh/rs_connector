'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateSecret, generateTotp, verifyTotp, getOtpauthUri, base32Encode, base32Decode } = require('../src/admin/totp');

// Vecteur RFC 6238 (SHA1) : secret ASCII "12345678901234567890" en base32, à T=59s
// (compteur 1), le code 8 chiffres est 94287082 → 6 chiffres = 287082.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('base32 encode/decode est réversible', () => {
  const buf = Buffer.from('hello world', 'utf8');
  assert.equal(base32Decode(base32Encode(buf)).toString('utf8'), 'hello world');
});

test('generateTotp correspond au vecteur de test RFC 6238 (T=59s → 287082)', () => {
  assert.equal(generateTotp(RFC_SECRET, { now: 59 * 1000 }), '287082');
});

test('verifyTotp accepte le code courant et refuse un mauvais code', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const code = generateTotp(secret, { now });
  assert.equal(verifyTotp(secret, code, { now }), true);
  assert.equal(verifyTotp(secret, '000000', { now }), false);
  assert.equal(verifyTotp(secret, 'abcdef', { now }), false);
  assert.equal(verifyTotp(secret, null, { now }), false);
});

test('verifyTotp tolère la fenêtre ±1 pas mais pas au-delà', () => {
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const prevStepCode = generateTotp(secret, { now: now - 30_000 });
  const farCode = generateTotp(secret, { now: now - 120_000 });
  assert.equal(verifyTotp(secret, prevStepCode, { now, window: 1 }), true);
  assert.equal(verifyTotp(secret, farCode, { now, window: 1 }), false);
});

test('getOtpauthUri produit une URI otpauth valide', () => {
  const uri = getOtpauthUri('ABC234', 'admin@rs-connector', 'rs-connector');
  assert.ok(uri.startsWith('otpauth://totp/rs-connector:admin%40rs-connector?'));
  assert.ok(uri.includes('secret=ABC234'));
  assert.ok(uri.includes('issuer=rs-connector'));
});
