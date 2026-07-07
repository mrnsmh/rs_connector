'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createVault, generateKey, PREFIX } = require('../src/crypto-vault');

const KEY = crypto.randomBytes(32).toString('base64');

test('encrypt/decrypt : round-trip d\'une chaîne', () => {
  const vault = createVault(KEY);
  const secret = 'token-super-sensible-123';
  const enc = vault.encrypt(secret);
  assert.ok(enc.startsWith(`${PREFIX}.`));
  assert.notEqual(enc, secret);
  assert.equal(vault.decrypt(enc), secret);
});

test('encryptJson/decryptJson : round-trip d\'un objet de credentials', () => {
  const vault = createVault(KEY);
  const creds = { token: 'abc', phoneNumberId: '123', smtp: { user: 'a@b.c', pass: 'p' } };
  const enc = vault.encryptJson(creds);
  assert.deepEqual(vault.decryptJson(enc), creds);
});

test('deux chiffrements du même clair diffèrent (IV aléatoire)', () => {
  const vault = createVault(KEY);
  assert.notEqual(vault.encrypt('same'), vault.encrypt('same'));
});

test('toute altération du chiffré fait échouer le déchiffrement (intégrité GCM)', () => {
  const vault = createVault(KEY);
  const enc = vault.encrypt('donnée intègre');
  const parts = enc.split('.');
  // Altère un octet du ciphertext.
  const ct = Buffer.from(parts[3], 'base64');
  ct[0] ^= 0xff;
  const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${ct.toString('base64')}`;
  assert.throws(() => vault.decrypt(tampered));
});

test('déchiffrer avec une autre clé échoue', () => {
  const enc = createVault(KEY).encrypt('secret');
  const other = createVault(crypto.randomBytes(32).toString('base64'));
  assert.throws(() => other.decrypt(enc));
});

test('format de chiffré invalide → throw', () => {
  const vault = createVault(KEY);
  assert.throws(() => vault.decrypt('pas-un-format'));
  assert.throws(() => vault.decrypt('gcm1.only.three'));
});

test('createVault rejette une clé de mauvaise taille', () => {
  assert.throws(() => createVault('trop-court'));
  assert.throws(() => createVault(Buffer.alloc(16)));
});

test('generateKey produit une clé base64 de 32 octets', () => {
  assert.equal(Buffer.from(generateKey(), 'base64').length, 32);
});
