'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiKeyAuth, extractBearer } = require('../src/auth-apikey');
const { hashApiKey } = require('../src/api-key');

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('extractBearer lit le token Bearer, insensible à la casse', () => {
  assert.equal(extractBearer({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
  assert.equal(extractBearer({ headers: { authorization: 'bearer xyz' } }), 'xyz');
  assert.equal(extractBearer({ headers: {} }), null);
  assert.equal(extractBearer({}), null);
});

test('401 si aucune clé API fournie', async () => {
  const auth = createApiKeyAuth({ async getApplicationByApiKeyHash() { return null; } });
  const res = mockRes();
  let nexted = false;
  await auth({ headers: {} }, res, () => { nexted = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nexted, false);
});

test('401 si clé API invalide (aucune application ne correspond)', async () => {
  const auth = createApiKeyAuth({ async getApplicationByApiKeyHash() { return null; } });
  const res = mockRes();
  let nexted = false;
  await auth({ headers: { authorization: 'Bearer wrong-key' } }, res, () => { nexted = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nexted, false);
});

test('req.application renseignée + next() appelé si la clé est valide', async () => {
  const apiKey = 'dk_valid-key';
  const appRow = { id: 'app-1', name: 'App', status: 'active', api_key_hash: hashApiKey(apiKey) };
  const db = { async getApplicationByApiKeyHash(h) { return h === appRow.api_key_hash ? appRow : null; } };
  const auth = createApiKeyAuth(db);
  const req = { headers: { authorization: `Bearer ${apiKey}` } };
  const res = mockRes();
  let nexted = false;
  await auth(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.statusCode, null);
  assert.equal(req.application.id, 'app-1');
});

test('401 si application désactivée', async () => {
  const apiKey = 'dk_disabled-app';
  const appRow = { id: 'app-2', status: 'disabled', api_key_hash: hashApiKey(apiKey) };
  const db = { async getApplicationByApiKeyHash() { return appRow; } };
  const auth = createApiKeyAuth(db);
  const res = mockRes();
  let nexted = false;
  await auth({ headers: { authorization: `Bearer ${apiKey}` } }, res, () => { nexted = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(nexted, false);
});

test('503 si la base n\'est pas initialisée', async () => {
  const auth = createApiKeyAuth(null);
  const res = mockRes();
  await auth({ headers: { authorization: 'Bearer x' } }, res, () => {});
  assert.equal(res.statusCode, 503);
});
