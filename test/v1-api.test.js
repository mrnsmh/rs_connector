'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const createApp = require('../src/app');
const { hashApiKey } = require('../src/api-key');

const API_KEY = 'dk_app1-secret';
const APP1 = { id: 'app-1', name: 'App One', status: 'active', api_key_hash: hashApiKey(API_KEY) };
const authHeader = { Authorization: `Bearer ${API_KEY}` };

// Deux connexions : c1 appartient à app-1 (l'appelante), c2 à app-2 (une autre app).
function buildDb() {
  const connections = {
    c1: { connection_id: 'c1', channel_type: 'whatsapp_baileys', status: 'connected', application_id: 'app-1' },
    c2: { connection_id: 'c2', channel_type: 'telegram', status: 'connected', application_id: 'app-2' },
  };
  return {
    async getApplicationByApiKeyHash(hash) { return hash === APP1.api_key_hash ? APP1 : null; },
    async getConnectionForApplication(appId, connId) {
      const c = connections[connId];
      return c && c.application_id === appId ? c : null;
    },
    async listConnectionsByApplication(appId) {
      return Object.values(connections).filter((c) => c.application_id === appId);
    },
  };
}

function buildConnectionManager(sent) {
  return {
    get() {
      return {
        sendMessage: async (to, text) => { sent.push({ to, text }); return { jid: `${to}@s.whatsapp.net`, messageId: 'mid-1' }; },
        getState: () => ({ connected: true, status: 'connected' }),
      };
    },
    getAllStates() { return { c1: { status: 'connected' } }; },
  };
}

test('POST /v1/messages sans clé API → 401', async () => {
  const app = createApp({ db: buildDb(), connectionManager: buildConnectionManager([]) });
  const res = await supertest(app).post('/v1/messages').send({ connection_id: 'c1', to: '212600000000', text: 'hi' });
  assert.equal(res.status, 401);
});

test('POST /v1/messages vers une connexion de l\'app → 200 et message envoyé', async () => {
  const sent = [];
  const app = createApp({ db: buildDb(), connectionManager: buildConnectionManager(sent) });
  const res = await supertest(app).post('/v1/messages').set(authHeader).send({ connection_id: 'c1', to: '212600000000', text: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(res.body.messageId, 'mid-1');
  assert.equal(sent.length, 1);
});

test('POST /v1/messages vers la connexion d\'une AUTRE app → 404 (scoping strict)', async () => {
  const sent = [];
  const app = createApp({ db: buildDb(), connectionManager: buildConnectionManager(sent) });
  const res = await supertest(app).post('/v1/messages').set(authHeader).send({ connection_id: 'c2', to: '212600000000', text: 'hi' });
  assert.equal(res.status, 404);
  assert.equal(sent.length, 0, 'aucun envoi ne doit avoir lieu vers une connexion non possédée');
});

test('POST /v1/messages avec champs manquants → 400', async () => {
  const app = createApp({ db: buildDb(), connectionManager: buildConnectionManager([]) });
  const res = await supertest(app).post('/v1/messages').set(authHeader).send({ connection_id: 'c1' });
  assert.equal(res.status, 400);
});

test('POST /v1/messages : session existante mais canal non connecté → 409 connection_not_active', async () => {
  const sent = [];
  // Session présente (ex. WhatsApp en attente de scan QR) mais isConnected() === false :
  // l'envoi ne doit pas être tenté et l'API renvoie le 409 contractuel (pas un 500).
  const connectionManager = {
    get() {
      return {
        isConnected: () => false,
        sendMessage: async (to, text) => { sent.push({ to, text }); return { messageId: 'nope' }; },
        getState: () => ({ connected: false, status: 'connecting' }),
      };
    },
    getAllStates() { return { c1: { status: 'connecting' } }; },
  };
  const app = createApp({ db: buildDb(), connectionManager });
  const res = await supertest(app).post('/v1/messages').set(authHeader).send({ connection_id: 'c1', to: '212600000000', text: 'hi' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'connection_not_active');
  assert.equal(sent.length, 0, 'aucun envoi ne doit avoir lieu si le canal n\'est pas connecté');
});

test('GET /v1/connections ne liste que les connexions de l\'app appelante', async () => {
  const app = createApp({ db: buildDb(), connectionManager: buildConnectionManager([]) });
  const res = await supertest(app).get('/v1/connections').set(authHeader);
  assert.equal(res.status, 200);
  assert.equal(res.body.connexions.length, 1);
  assert.equal(res.body.connexions[0].connectionId, 'c1');
  assert.equal(res.body.connexions[0].channelType, 'whatsapp_baileys');
});

test('GET /v1/connections expose le canal par d\'efaut de l\'app (defaultConnectionId + isDefault)', async () => {
  const db = buildDb();
  const appWithDefault = { ...APP1, default_connection_id: 'c1' };
  db.getApplicationByApiKeyHash = async (hash) => (hash === APP1.api_key_hash ? appWithDefault : null);
  const app = createApp({ db, connectionManager: buildConnectionManager([]) });
  const res = await supertest(app).get('/v1/connections').set(authHeader);
  assert.equal(res.status, 200);
  assert.equal(res.body.defaultConnectionId, 'c1');
  assert.equal(res.body.connexions[0].isDefault, true);
});

test('GET /v1/connections/:id refuse une connexion d\'une autre app → 404', async () => {
  const app = createApp({ db: buildDb(), connectionManager: buildConnectionManager([]) });
  const res = await supertest(app).get('/v1/connections/c2').set(authHeader);
  assert.equal(res.status, 404);
});

test('GET /v1/connections/:id retourne la connexion possédée', async () => {
  const app = createApp({ db: buildDb(), connectionManager: buildConnectionManager([]) });
  const res = await supertest(app).get('/v1/connections/c1').set(authHeader);
  assert.equal(res.status, 200);
  assert.equal(res.body.connectionId, 'c1');
});

// --- Sélection du canal à l'envoi (argument `channel`, Task 13) -----------------

// app-1 possède plusieurs connexions : 1 WhatsApp + 2 Telegram (pour tester l'ambiguïté).
function buildMultiDb() {
  const connections = {
    c1: { connection_id: 'c1', channel_type: 'whatsapp_baileys', status: 'connected', application_id: 'app-1' },
    t1: { connection_id: 't1', channel_type: 'telegram', status: 'connected', application_id: 'app-1' },
    t2: { connection_id: 't2', channel_type: 'telegram', status: 'connected', application_id: 'app-1' },
  };
  return {
    async getApplicationByApiKeyHash(hash) { return hash === APP1.api_key_hash ? APP1 : null; },
    async getConnectionForApplication(appId, connId) {
      const c = connections[connId];
      return c && c.application_id === appId ? c : null;
    },
    async listConnectionsByApplication(appId) {
      return Object.values(connections).filter((c) => c.application_id === appId);
    },
  };
}

test('POST /v1/messages : channel sélectionne la connexion (app à connexion unique)', async () => {
  const sent = [];
  const app = createApp({ db: buildDb(), connectionManager: buildConnectionManager(sent) });
  const res = await supertest(app).post('/v1/messages').set(authHeader).send({ channel: 'whatsapp_baileys', to: '212600000000', text: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(res.body.connectionId, 'c1');
  assert.equal(res.body.channel, 'whatsapp_baileys');
  assert.equal(sent.length, 1);
});

test('POST /v1/messages : app à connexion unique, sans channel ni connection_id → 200 (défaut)', async () => {
  const sent = [];
  const app = createApp({ db: buildDb(), connectionManager: buildConnectionManager(sent) });
  const res = await supertest(app).post('/v1/messages').set(authHeader).send({ to: '212600000000', text: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(res.body.connectionId, 'c1');
});

test('POST /v1/messages : channel sans connexion correspondante → 404', async () => {
  const sent = [];
  const app = createApp({ db: buildDb(), connectionManager: buildConnectionManager(sent) });
  const res = await supertest(app).post('/v1/messages').set(authHeader).send({ channel: 'telegram', to: 'x', text: 'hi' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'connection_not_found');
  assert.equal(sent.length, 0);
});

test('POST /v1/messages : plusieurs connexions, sans sélecteur → 400 channel_required', async () => {
  const sent = [];
  const app = createApp({ db: buildMultiDb(), connectionManager: buildConnectionManager(sent) });
  const res = await supertest(app).post('/v1/messages').set(authHeader).send({ to: 'x', text: 'hi' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'channel_required');
  assert.equal(sent.length, 0);
});

test('POST /v1/messages : plusieurs connexions du même canal → 400 ambiguous_connection', async () => {
  const sent = [];
  const app = createApp({ db: buildMultiDb(), connectionManager: buildConnectionManager(sent) });
  const res = await supertest(app).post('/v1/messages').set(authHeader).send({ channel: 'telegram', to: 'x', text: 'hi' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'ambiguous_connection');
  assert.equal(sent.length, 0);
});

test('POST /v1/messages : ambiguïté de canal levée par connection_id → 200', async () => {
  const sent = [];
  const app = createApp({ db: buildMultiDb(), connectionManager: buildConnectionManager(sent) });
  const res = await supertest(app).post('/v1/messages').set(authHeader).send({ connection_id: 't1', channel: 'telegram', to: 'x', text: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(res.body.connectionId, 't1');
  assert.equal(sent.length, 1);
});

test('POST /v1/messages : connection_id d\'un canal différent de channel → 400 channel_mismatch', async () => {
  const sent = [];
  const app = createApp({ db: buildMultiDb(), connectionManager: buildConnectionManager(sent) });
  const res = await supertest(app).post('/v1/messages').set(authHeader).send({ connection_id: 'c1', channel: 'telegram', to: 'x', text: 'hi' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'channel_mismatch');
  assert.equal(sent.length, 0);
});
