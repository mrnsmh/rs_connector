'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const createApp = require('../src/app');
const { hashApiKey } = require('../src/api-key');

const API_KEY = 'dk_pair-secret';
const APP = { id: 'app-pair', name: 'Pair App', status: 'active', api_key_hash: hashApiKey(API_KEY) };
const authHeader = { Authorization: `Bearer ${API_KEY}` };

function buildDb() {
  const connections = {
    c1: { connection_id: 'c1', channel_type: 'whatsapp_whtsp', status: 'qr_required', application_id: 'app-pair' },
    c2: { connection_id: 'c2', channel_type: 'telegram', status: 'connected', application_id: 'app-pair' },
  };
  return {
    async getApplicationByApiKeyHash(hash) { return hash === APP.api_key_hash ? APP : null; },
    async getConnectionForApplication(appId, connId) {
      const c = connections[connId];
      return c && c.application_id === appId ? c : null;
    },
  };
}

function buildConnectionManager({ pairingSupported = true } = {}) {
  const calls = [];
  const session = {
    connect: async () => {},
    // Miroir de la validation réelle des adaptateurs (numéro international, chiffres seuls).
    requestPairingCode: pairingSupported
      ? async (phone) => {
          const digits = String(phone || '').replace(/[^0-9]/g, '');
          if (!/^\d{8,15}$/.test(digits)) {
            const err = new Error('Numéro invalide');
            err.statusCode = 400;
            throw err;
          }
          calls.push(phone);
          return 'XY12-9876';
        }
      : undefined,
    getState: () => ({ status: 'pairing_code_sent', connected: false }),
  };
  return {
    calls,
    getOrCreate: async () => session,
    get: () => session,
    getAllStates() { return {}; },
  };
}

test('POST /v1/connections/:id/pairing-code retourne le code pour un canal WhatsApp', async () => {
  const cm = buildConnectionManager();
  const app = createApp({ db: buildDb(), connectionManager: cm });
  const res = await supertest(app)
    .post('/v1/connections/c1/pairing-code')
    .set(authHeader)
    .send({ phone: '+212 612 345 678' });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pairing_code_sent');
  assert.equal(res.body.pairingCode, 'XY12-9876');
  // Le numéro est transmis brut à l'adaptateur : la normalisation (chiffres seuls)
  // relève de session.requestPairingCode / adapter.requestPairingCode.
  assert.deepEqual(cm.calls, ['+212 612 345 678']);
});

test('POST /v1/connections/:id/pairing-code : 400 si phone manquant', async () => {
  const cm = buildConnectionManager();
  const app = createApp({ db: buildDb(), connectionManager: cm });
  const res = await supertest(app)
    .post('/v1/connections/c1/pairing-code')
    .set(authHeader)
    .send({});

  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test('POST /v1/connections/:id/pairing-code : 501 si le canal ne supporte pas le code', async () => {
  const cm = buildConnectionManager({ pairingSupported: false });
  const app = createApp({ db: buildDb(), connectionManager: cm });
  const res = await supertest(app)
    .post('/v1/connections/c1/pairing-code')
    .set(authHeader)
    .send({ phone: '212612345678' });

  assert.equal(res.status, 501);
});

test('POST /v1/connections/:id/pairing-code : 401 sans clé API', async () => {
  const app = createApp({ db: buildDb(), connectionManager: buildConnectionManager() });
  const res = await supertest(app)
    .post('/v1/connections/c1/pairing-code')
    .send({ phone: '212612345678' });

  assert.equal(res.status, 401);
});
