'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const createApp = require('../src/app');

const WT = 'worker-secret-token';
const hdr = { 'X-Worker-Token': WT };

function cmWithSession(sent) {
  return {
    get() {
      return {
        sendMessage: async (to, text) => { sent.push({ to, text }); return { messageId: 'mid-int', jid: `${to}@s` }; },
      };
    },
    getAllStates() { return {}; },
  };
}

function cmNoSession() {
  return { get() { return null; }, getAllStates() { return {}; } };
}

test('POST /internal/send sans token → 401', async () => {
  const app = createApp({ connectionManager: cmWithSession([]), workerToken: WT });
  const res = await supertest(app).post('/internal/send').send({ connectionId: 'c1', to: 'x', text: 'y' });
  assert.equal(res.status, 401);
});

test('POST /internal/send token invalide → 401', async () => {
  const app = createApp({ connectionManager: cmWithSession([]), workerToken: WT });
  const res = await supertest(app).post('/internal/send').set({ 'X-Worker-Token': 'nope' }).send({ connectionId: 'c1', to: 'x', text: 'y' });
  assert.equal(res.status, 401);
});

test('POST /internal/send champs manquants → 400', async () => {
  const app = createApp({ connectionManager: cmWithSession([]), workerToken: WT });
  const res = await supertest(app).post('/internal/send').set(hdr).send({ connectionId: 'c1' });
  assert.equal(res.status, 400);
});

test('POST /internal/send connexion inactive → 409', async () => {
  const app = createApp({ connectionManager: cmNoSession(), workerToken: WT });
  const res = await supertest(app).post('/internal/send').set(hdr).send({ connectionId: 'c1', to: 'x', text: 'y' });
  assert.equal(res.status, 409);
});

test('POST /internal/send OK → 200 et message envoyé', async () => {
  const sent = [];
  const app = createApp({ connectionManager: cmWithSession(sent), workerToken: WT });
  const res = await supertest(app).post('/internal/send').set(hdr).send({ connectionId: 'c1', to: '212600000000', text: 'salut' });
  assert.equal(res.status, 200);
  assert.equal(res.body.messageId, 'mid-int');
  assert.equal(sent.length, 1);
});

test('POST /internal/send sans workerToken configuré → 503', async () => {
  const app = createApp({ connectionManager: cmWithSession([]), workerToken: '' });
  const res = await supertest(app).post('/internal/send').set(hdr).send({ connectionId: 'c1', to: 'x', text: 'y' });
  assert.equal(res.status, 503);
});
