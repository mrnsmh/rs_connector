'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const createApp = require('../src/app');
const { hashApiKey } = require('../src/api-key');

const API_KEY = 'dk_health-secret';
const APP = { id: 'app-health', name: 'Health App', status: 'active', api_key_hash: hashApiKey(API_KEY) };
const authHeader = { Authorization: `Bearer ${API_KEY}` };

function buildDb() {
  const connections = {
    c1: { connection_id: 'c1', channel_type: 'whatsapp_whtsp', status: 'connected', application_id: 'app-health' },
    c2: { connection_id: 'c2', channel_type: 'whatsapp_baileys', status: 'connected', application_id: 'app-health' },
    foreign: { connection_id: 'foreign', channel_type: 'whatsapp_whtsp', status: 'connected', application_id: 'other-app' },
  };
  return {
    async getApplicationByApiKeyHash(hash) { return hash === APP.api_key_hash ? APP : null; },
    async getConnectionForApplication(appId, connId) {
      const c = connections[connId];
      return c && c.application_id === appId ? c : null;
    },
    async listConnectionsByApplication(appId) {
      return Object.values(connections).filter((c) => c.application_id === appId);
    },
  };
}

// Session whatsapp_whtsp : expose antiBan.getState() (HealthMonitor de @whtsp/core).
function whtspSession(overrides = {}) {
  const state = {
    health: { risk: 'low', score: 0, reasons: [], uptime: 3600, failedMessages: 0, successfulMessages: 5 },
    deliveryRate: 0.9,
    paused: false,
  };
  return {
    getState: () => ({ connected: true, status: 'connected' }),
    antiBan: { getState: () => ({ ...state, ...overrides.state }) },
  };
}

// Session sans anti-ban (ex. whatsapp_baileys legacy).
function legacySession() {
  return { getState: () => ({ connected: true, status: 'connected' }) };
}

function buildConnectionManager(sessions) {
  return {
    get: (id) => sessions[id] || null,
    getAllStates() { return {}; },
  };
}

function buildApp(sessions) {
  return createApp({
    connectionManager: buildConnectionManager(sessions),
    db: buildDb(),
  });
}

test('GET /v1/connections/:id/health : 401 sans clé API', async () => {
  const res = await supertest(buildApp({ c1: whtspSession() })).get('/v1/connections/c1/health');
  assert.equal(res.status, 401);
});

test('GET /v1/connections/:id/health : 404 pour une connexion inconnue', async () => {
  const res = await supertest(buildApp({})).get('/v1/connections/nope/health').set(authHeader);
  assert.equal(res.status, 404);
});

test("GET /v1/connections/:id/health : 404 pour une connexion d'une autre application", async () => {
  const res = await supertest(buildApp({})).get('/v1/connections/foreign/health').set(authHeader);
  assert.equal(res.status, 404);
});

test('GET /v1/connections/:id/health expose le risque anti-ban (whatsapp_whtsp)', async () => {
  const res = await supertest(buildApp({ c1: whtspSession() })).get('/v1/connections/c1/health').set(authHeader);
  assert.equal(res.status, 200);
  assert.equal(res.body.connectionId, 'c1');
  assert.equal(res.body.channelType, 'whatsapp_whtsp');
  assert.equal(res.body.status, 'connected');
  assert.equal(res.body.risk.level, 'low');
  assert.equal(res.body.risk.score, 0);
  assert.deepEqual(res.body.risk.reasons, []);
  assert.equal(res.body.deliveryRate, 0.9);
  assert.equal(res.body.uptimeSeconds, 3600);
  assert.equal(res.body.recommendedAction, 'none');
});

test('risque high → recommendedAction reduce_volume', async () => {
  const session = whtspSession({ state: { health: { risk: 'high', score: 45, reasons: ['5 disconnects in last hour'] }, deliveryRate: 0.7 } });
  const res = await supertest(buildApp({ c1: session })).get('/v1/connections/c1/health').set(authHeader);
  assert.equal(res.status, 200);
  assert.equal(res.body.risk.level, 'high');
  assert.equal(res.body.recommendedAction, 'reduce_volume');
});

test('risque critical → recommendedAction pause_and_fallback', async () => {
  const session = whtspSession({ state: { health: { risk: 'critical', score: 80, reasons: ['forbidden'] }, paused: true } });
  const res = await supertest(buildApp({ c1: session })).get('/v1/connections/c1/health').set(authHeader);
  assert.equal(res.status, 200);
  assert.equal(res.body.risk.level, 'critical');
  assert.equal(res.body.recommendedAction, 'paused');
});

test('canal sans anti-ban → risk unknown (antiban_non_actif), jamais bloquant', async () => {
  const res = await supertest(buildApp({ c2: legacySession() })).get('/v1/connections/c2/health').set(authHeader);
  assert.equal(res.status, 200);
  assert.equal(res.body.channelType, 'whatsapp_baileys');
  assert.equal(res.body.risk.level, 'unknown');
  assert.deepEqual(res.body.risk.reasons, ['antiban_non_actif']);
  assert.equal(res.body.recommendedAction, 'none');
});

test('GET /v1/connections/:id/health : 503 sans connectionManager', async () => {
  const app = createApp({ db: buildDb() });
  const res = await supertest(app).get('/v1/connections/c1/health').set(authHeader);
  assert.equal(res.status, 503);
});
