'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateApiKey, hashApiKey, API_KEY_PREFIX } = require('../src/api-key');

test('generateApiKey produit une clé préfixée, un préfixe visible et un hash SHA-256', () => {
  const { apiKey, prefix, hash } = generateApiKey();
  assert.ok(apiKey.startsWith(API_KEY_PREFIX), 'la clé doit être préfixée dk_');
  assert.ok(apiKey.length > 20, 'la clé doit être suffisamment longue');
  assert.ok(apiKey.startsWith(prefix), 'le préfixe doit être un début de la clé');
  assert.equal(hash, hashApiKey(apiKey), 'le hash retourné doit correspondre à hashApiKey');
  assert.match(hash, /^[0-9a-f]{64}$/, 'le hash doit être un SHA-256 hex');
});

test('deux clés générées sont différentes', () => {
  assert.notEqual(generateApiKey().apiKey, generateApiKey().apiKey);
});

test('hashApiKey est déterministe et ne renvoie jamais la clé en clair', () => {
  const { apiKey, hash } = generateApiKey();
  assert.equal(hashApiKey(apiKey), hash);
  assert.notEqual(hash, apiKey);
});
