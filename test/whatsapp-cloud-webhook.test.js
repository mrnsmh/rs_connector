'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const supertest = require('supertest');
const createApp = require('../src/app');
const { verifyMetaSignature, checkVerification, extractInboundEvents } = require('../src/whatsapp-cloud-webhook');

// --- Helpers purs ---

test('verifyMetaSignature accepte une signature valide et rejette le reste', () => {
  const secret = 'app-secret';
  const body = JSON.stringify({ hello: 'world' });
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, sig, secret), true);
  assert.equal(verifyMetaSignature(body, sig, 'wrong-secret'), false);
  assert.equal(verifyMetaSignature(body, 'sha256=deadbeef', secret), false);
  assert.equal(verifyMetaSignature(body, null, secret), false);
  assert.equal(verifyMetaSignature(body, sig, ''), false);
});

test('checkVerification valide le hub.verify_token et renvoie le challenge', () => {
  const ok = checkVerification({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '12345' }, 'tok');
  assert.deepEqual(ok, { ok: true, challenge: '12345' });
  assert.equal(checkVerification({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': 'x' }, 'tok').ok, false);
  assert.equal(checkVerification({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok' }, '').ok, false);
});

test('extractInboundEvents extrait phone_number_id + value, robuste aux payloads vides', () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA',
      changes: [{ field: 'messages', value: { metadata: { phone_number_id: '999' }, messages: [{ id: 'm1' }] } }],
    }],
  };
  const events = extractInboundEvents(payload);
  assert.equal(events.length, 1);
  assert.equal(events[0].phoneNumberId, '999');
  assert.ok(events[0].value.messages);
  assert.deepEqual(extractInboundEvents({}), []);
  assert.deepEqual(extractInboundEvents(null), []);
  assert.deepEqual(extractInboundEvents({ entry: [{}] }), []);
});

// --- Routes Express ---

function buildConnectionManager(ingested) {
  return {
    findByChannelRef(channelType, ref) {
      if (channelType === 'whatsapp_cloud' && ref === '999') {
        return { ingestWebhook: (value) => { ingested.push(value); return { messages: 1, statuses: 0 }; } };
      }
      return null;
    },
  };
}

test('GET /webhooks/whatsapp-cloud renvoie le challenge si le verify_token correspond', async () => {
  const app = createApp({ whatsappCloud: { verifyToken: 'monToken' } });
  const res = await supertest(app)
    .get('/webhooks/whatsapp-cloud')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'monToken', 'hub.challenge': 'CHALLENGE-42' });
  assert.equal(res.status, 200);
  assert.equal(res.text, 'CHALLENGE-42');
});

test('GET /webhooks/whatsapp-cloud renvoie 403 si le verify_token est mauvais', async () => {
  const app = createApp({ whatsappCloud: { verifyToken: 'monToken' } });
  const res = await supertest(app)
    .get('/webhooks/whatsapp-cloud')
    .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'intrus', 'hub.challenge': 'x' });
  assert.equal(res.status, 403);
});

test('POST /webhooks/whatsapp-cloud route l\'événement vers l\'adaptateur par phone_number_id', async () => {
  const ingested = [];
  const app = createApp({ connectionManager: buildConnectionManager(ingested), whatsappCloud: {} }); // pas d'appSecret → signature ignorée
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: '999' }, messages: [{ from: '212', id: 'm1', text: { body: 'hi' } }] } }] }],
  };
  const res = await supertest(app).post('/webhooks/whatsapp-cloud').send(payload);
  assert.equal(res.status, 200);
  assert.equal(res.body.received, true);
  assert.equal(ingested.length, 1);
  assert.ok(ingested[0].messages);
});

test('POST /webhooks/whatsapp-cloud répond 200 même si le phone_number_id est inconnu', async () => {
  const ingested = [];
  const app = createApp({ connectionManager: buildConnectionManager(ingested), whatsappCloud: {} });
  const payload = {
    entry: [{ changes: [{ value: { metadata: { phone_number_id: 'INCONNU' }, messages: [{ id: 'm1' }] } }] }],
  };
  const res = await supertest(app).post('/webhooks/whatsapp-cloud').send(payload);
  assert.equal(res.status, 200);
  assert.equal(ingested.length, 0);
});
