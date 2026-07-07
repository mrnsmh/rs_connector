'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const createApp = require('../src/app');
const { hashApiKey } = require('../src/api-key');

const API_KEY = 'dk_appdef-secret';
const auth = { Authorization: `Bearer ${API_KEY}` };

function appWithDefault(defaultId) {
  return { id: 'app-def', name: 'AppDef', status: 'active', api_key_hash: hashApiKey(API_KEY), default_connection_id: defaultId };
}

// app-def possède 1 WhatsApp (c1) + 2 Telegram (t1, t2) → ambigu sans sélecteur.
function buildDb(defaultId) {
  const app = appWithDefault(defaultId);
  const connections = {
    c1: { connection_id: 'c1', channel_type: 'whatsapp_baileys', status: 'connected', application_id: 'app-def' },
    t1: { connection_id: 't1', channel_type: 'telegram', status: 'connected', application_id: 'app-def' },
    t2: { connection_id: 't2', channel_type: 'telegram', status: 'connected', application_id: 'app-def' },
  };
  return {
    async getApplicationByApiKeyHash(hash) { return hash === app.api_key_hash ? app : null; },
    async getConnectionForApplication(appId, connId) { const c = connections[connId]; return c && c.application_id === appId ? c : null; },
    async listConnectionsByApplication(appId) { return Object.values(connections).filter((c) => c.application_id === appId); },
  };
}

function buildCm(sent) {
  return {
    get() { return { sendMessage: async (to, text) => { sent.push({ to, text }); return { messageId: 'mid', jid: `${to}@s` }; }, isConnected: () => true }; },
    getAllStates() { return {}; },
  };
}

test('canal par défaut : plusieurs connexions, aucun sélecteur, défaut défini → 200 via le défaut', async () => {
  const sent = [];
  const app = createApp({ db: buildDb('t1'), connectionManager: buildCm(sent) });
  const res = await supertest(app).post('/v1/messages').set(auth).send({ to: '212600000000', text: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(res.body.connectionId, 't1');
  assert.equal(res.body.channel, 'telegram');
  assert.equal(sent.length, 1);
});

test('canal par défaut : plusieurs connexions, aucun sélecteur, PAS de défaut → 400 channel_required', async () => {
  const sent = [];
  const app = createApp({ db: buildDb(null), connectionManager: buildCm(sent) });
  const res = await supertest(app).post('/v1/messages').set(auth).send({ to: 'x', text: 'hi' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'channel_required');
  assert.equal(sent.length, 0);
});

test('canal par défaut : channel fourni mais ambigu → 400 ambiguous (le défaut ne s\'applique qu\'en absence de channel)', async () => {
  const sent = [];
  const app = createApp({ db: buildDb('t1'), connectionManager: buildCm(sent) });
  const res = await supertest(app).post('/v1/messages').set(auth).send({ channel: 'telegram', to: 'x', text: 'hi' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'ambiguous_connection');
  assert.equal(sent.length, 0);
});

test('canal par défaut : default obsolète (connexion absente) → 400 channel_required (repli sûr)', async () => {
  const sent = [];
  const app = createApp({ db: buildDb('zzz'), connectionManager: buildCm(sent) });
  const res = await supertest(app).post('/v1/messages').set(auth).send({ to: 'x', text: 'hi' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'channel_required');
  assert.equal(sent.length, 0);
});

test('canal par défaut : une seule connexion → utilisée sans défaut (comportement inchangé)', async () => {
  const sent = [];
  const solo = {
    async getApplicationByApiKeyHash(hash) { return hash === hashApiKey(API_KEY) ? appWithDefault(null) : null; },
    async getConnectionForApplication() { return null; },
    async listConnectionsByApplication() { return [{ connection_id: 'only', channel_type: 'telegram', status: 'connected', application_id: 'app-def' }]; },
  };
  const app = createApp({ db: solo, connectionManager: buildCm(sent) });
  const res = await supertest(app).post('/v1/messages').set(auth).send({ to: 'x', text: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(res.body.connectionId, 'only');
  assert.equal(sent.length, 1);
});
