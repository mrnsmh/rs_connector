'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const createApp = require('../src/app');

test('GET /health répond 200 avec un statut ok', async () => {
  const app = createApp();
  const res = await supertest(app).get('/health');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.service, 'rs-connector');
  assert.equal(typeof res.body.uptimeSeconds, 'number');
});

test("createApp() n'échoue pas et retourne une app Express utilisable", () => {
  assert.doesNotThrow(() => {
    const app = createApp();
    assert.equal(typeof app.listen, 'function');
  });
});
