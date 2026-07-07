'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../src/admin/password');

test('hashPassword produit un hash scrypt versionné et non réversible', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
  assert.ok(!hash.includes('correct horse'));
});

test('deux hachages du même mot de passe diffèrent (salt aléatoire)', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('verifyPassword accepte le bon mot de passe et rejette les autres', () => {
  const hash = hashPassword('S3cr3t!');
  assert.equal(verifyPassword('S3cr3t!', hash), true);
  assert.equal(verifyPassword('mauvais', hash), false);
  assert.equal(verifyPassword('', hash), false);
});

test('verifyPassword renvoie false (sans exception) pour un hash mal formé', () => {
  assert.equal(verifyPassword('x', 'pas-un-hash'), false);
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', null), false);
  assert.equal(verifyPassword('x', 'scrypt$16384$8$1$onlyfiveparts'), false);
});
