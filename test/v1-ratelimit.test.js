'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const createApp = require('../src/app');
const { hashApiKey } = require('../src/api-key');

const API_KEY = 'dk_rl-secret';
const authH = { Authorization: `Bearer ${API_KEY}` };
const APP = { id: 'app-rl', name: 'RL', status: 'active', api_key_hash: hashApiKey(API_KEY) };

function buildDb() {
  const conn = { connection_id: 'c1', channel_type: 'telegram', status: 'connected', application_id: 'app-rl' };
  return {
    async getApplicationByApiKeyHash(h) { return h === APP.api_key_hash ? APP : null; },
    async getConnectionForApplication(a, id) { return (a === 'app-rl' && id === 'c1') ? conn : null; },
    async listConnectionsByApplication() { return [conn]; },
  };
}

function cm() {
  return {
    get() { return { sendMessage: async () => ({ messageId: 'm' }), isConnected: () => true }; },
    getAllStates() { return {}; },
  };
}

const body = { connection_id: 'c1', to: '212600000000', text: 'hi' };

test('/v1/messages : 429 au-delà de la limite par application', async () => {
  const app = createApp({ db: buildDb(), connectionManager: cm(), v1RateLimitPerMin: 2 });
  const r1 = await supertest(app).post('/v1/messages').set(authH).send(body);
  const r2 = await supertest(app).post('/v1/messages').set(authH).send(body);
  const r3 = await supertest(app).post('/v1/messages').set(authH).send(body);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429);
  assert.equal(r3.body.error, 'rate_limited');
  assert.ok(Number(r3.headers['retry-after']) >= 1, 'en-tête Retry-After présent');
});

test('/v1/messages : limite désactivée (0) => jamais de 429', async () => {
  const app = createApp({ db: buildDb(), connectionManager: cm(), v1RateLimitPerMin: 0 });
  for (let i = 0; i < 6; i++) {
    const r = await supertest(app).post('/v1/messages').set(authH).send(body);
    assert.equal(r.status, 200);
  }
});

test('/v1/messages : la limite est PAR application (une clé n\'épuise pas les autres)', async () => {
  // Même app appelée 2 fois avec limite 2 → 3e = 429 ; prouve le compteur par app.
  const app = createApp({ db: buildDb(), connectionManager: cm(), v1RateLimitPerMin: 2 });
  await supertest(app).post('/v1/messages').set(authH).send(body);
  await supertest(app).post('/v1/messages').set(authH).send(body);
  const blocked = await supertest(app).post('/v1/messages').set(authH).send(body);
  assert.equal(blocked.status, 429);
});
