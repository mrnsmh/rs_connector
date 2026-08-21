'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const createApp = require('../src/app');
const { hashApiKey } = require('../src/api-key');

const API_KEY = 'dk_qr-secret';
const APP = { id: 'app-qr', name: 'QR App', status: 'active', api_key_hash: hashApiKey(API_KEY) };
const authHeader = { Authorization: `Bearer ${API_KEY}` };

// c1 = canal anti-ban whatsapp_whtsp, c2 = legacy whatsapp_baileys.
function buildDb() {
  const connections = {
    c1: { connection_id: 'c1', channel_type: 'whatsapp_whtsp', status: 'qr_required', application_id: 'app-qr' },
    c2: { connection_id: 'c2', channel_type: 'whatsapp_baileys', status: 'qr_required', application_id: 'app-qr' },
  };
  return {
    async getApplicationByApiKeyHash(hash) { return hash === APP.api_key_hash ? APP : null; },
    async getConnectionForApplication(appId, connId) {
      const c = connections[connId];
      return c && c.application_id === appId ? c : null;
    },
  };
}

// Enregistre les appels getOrCreate pour vérifier le channelType transmis.
function buildConnectionManager() {
  const calls = [];
  const session = { connect: async () => {}, getState: () => ({ status: 'qr_required', qr: 'x' }) };
  return {
    calls,
    getOrCreate: async (connectionId, opts) => { calls.push({ connectionId, channelType: opts && opts.channelType }); return session; },
    get: () => session,
    getAllStates() { return { c1: { status: 'qr_required' }, c2: { status: 'qr_required' } }; },
  };
}

test('GET /v1/connections/:id/qr transmet le channel_type de la DB (whatsapp_whtsp)', async () => {
  const cm = buildConnectionManager();
  const app = createApp({ db: buildDb(), connectionManager: cm });
  const res = await supertest(app).get('/v1/connections/c1/qr').set(authHeader);
  assert.equal(res.status, 200);
  assert.equal(cm.calls.length, 1);
  assert.equal(cm.calls[0].connectionId, 'c1');
  assert.equal(cm.calls[0].channelType, 'whatsapp_whtsp');
});

test('GET /v1/connections/:id/qr transmet whatsapp_baileys pour un canal legacy', async () => {
  const cm = buildConnectionManager();
  const app = createApp({ db: buildDb(), connectionManager: cm });
  const res = await supertest(app).get('/v1/connections/c2/qr').set(authHeader);
  assert.equal(res.status, 200);
  assert.equal(cm.calls[0].channelType, 'whatsapp_baileys');
});

test('GET /v1/connections/:id/qr : 401 sans clé API', async () => {
  const cm = buildConnectionManager();
  const app = createApp({ db: buildDb(), connectionManager: cm });
  const res = await supertest(app).get('/v1/connections/c1/qr');
  assert.equal(res.status, 401);
  assert.equal(cm.calls.length, 0);
});

test('GET /v1/connections/:id/qr : 404 pour une connexion inconnue', async () => {
  const cm = buildConnectionManager();
  const app = createApp({ db: buildDb(), connectionManager: cm });
  const res = await supertest(app).get('/v1/connections/nope/qr').set(authHeader);
  assert.equal(res.status, 404);
  assert.equal(cm.calls.length, 0);
});