'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter, channelType, capabilities } = require('../src/adapters/whatsapp-cloud');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function buildGraphMock({ validateOk = true, sendResult, errorMsg } = {}) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'POST' && url.includes('/messages')) {
      return { ok: true, status: 200, json: async () => (sendResult || { messages: [{ id: 'wamid.HBgABC' }] }) };
    }
    if (validateOk) return { ok: true, status: 200, json: async () => ({ id: 'PN1' }) };
    return { ok: false, status: 401, json: async () => ({ error: { message: errorMsg || 'Invalid OAuth access token' } }) };
  };
  return { fetchFn, calls };
}

const creds = { token: 'EAA-token', phoneNumberId: '1234567890' };

test('capabilities et channelType du canal WhatsApp Cloud', () => {
  assert.equal(channelType, 'whatsapp_cloud');
  assert.equal(capabilities.auth, 'token');
  assert.equal(capabilities.inbound, true);
  assert.equal(capabilities.outbound, true);
  assert.equal(capabilities.statusReceipts, true);
});

test('connect() valide token+phone_number_id via Graph et passe à connected', async () => {
  const { fetchFn } = buildGraphMock({ validateOk: true });
  const states = [];
  const adapter = createAdapter({ fetchFn, logger: silentLogger }, '/tmp', {
    connectionId: 'wc1', credentials: creds, onConnectionStateChange: (s) => states.push(s.status),
  });
  await adapter.connect();
  assert.equal(adapter.isConnected(), true);
  assert.equal(adapter.getState().phoneNumberId, '1234567890');
  assert.equal(adapter.channelRef, '1234567890');
  assert.deepEqual(states, ['connected']);
});

test('connect() avec token invalide passe en error', async () => {
  const { fetchFn } = buildGraphMock({ validateOk: false });
  const adapter = createAdapter({ fetchFn, logger: silentLogger }, '/tmp', { credentials: creds });
  await adapter.connect();
  assert.equal(adapter.getState().status, 'error');
});

test('connect() sans token/phone_number_id passe en error sans réseau', async () => {
  let fetchCalled = false;
  const fetchFn = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
  const adapter = createAdapter({ fetchFn, logger: silentLogger }, '/tmp', { credentials: {} });
  await adapter.connect();
  assert.equal(adapter.getState().status, 'error');
  assert.equal(fetchCalled, false);
});

test('sendMessage() poste le bon payload à /{phoneNumberId}/messages et retourne le messageId', async () => {
  const { fetchFn, calls } = buildGraphMock({ sendResult: { messages: [{ id: 'wamid.XYZ' }] } });
  const adapter = createAdapter({ fetchFn, logger: silentLogger }, '/tmp', { credentials: creds });
  await adapter.connect();
  const res = await adapter.sendMessage('212600000000', 'Bonjour');
  assert.equal(res.messageId, 'wamid.XYZ');
  const send = calls.find((c) => c.method === 'POST' && c.url.includes('/messages'));
  assert.ok(send.url.includes('/1234567890/messages'));
  assert.equal(send.headers.Authorization, 'Bearer EAA-token');
  assert.equal(send.body.messaging_product, 'whatsapp');
  assert.equal(send.body.to, '212600000000');
  assert.equal(send.body.type, 'text');
  assert.equal(send.body.text.body, 'Bonjour');
});

test('ingestWebhook() remonte les messages entrants via onIncomingMessage', () => {
  const incoming = [];
  const adapter = createAdapter({ fetchFn: async () => ({ ok: true, json: async () => ({}) }), logger: silentLogger }, '/tmp', {
    credentials: creds, onIncomingMessage: (m) => incoming.push(m),
  });
  const value = {
    metadata: { phone_number_id: '1234567890' },
    messages: [{ from: '212611111111', id: 'wamid.IN1', type: 'text', text: { body: 'Salut' } }],
  };
  const counts = adapter.ingestWebhook(value);
  assert.equal(counts.messages, 1);
  assert.equal(incoming.length, 1);
  assert.deepEqual(incoming[0], { from: '212611111111', messageId: 'wamid.IN1', text: 'Salut' });
});

test('ingestWebhook() remonte les accusés de statut via onMessageStatusUpdate', () => {
  const statuses = [];
  const adapter = createAdapter({ fetchFn: async () => ({ ok: true, json: async () => ({}) }), logger: silentLogger }, '/tmp', {
    credentials: creds, onMessageStatusUpdate: (s) => statuses.push(s),
  });
  const value = {
    metadata: { phone_number_id: '1234567890' },
    statuses: [{ id: 'wamid.OUT1', status: 'delivered' }, { id: 'wamid.OUT1', status: 'read' }],
  };
  const counts = adapter.ingestWebhook(value);
  assert.equal(counts.statuses, 2);
  assert.deepEqual(statuses, [
    { messageId: 'wamid.OUT1', status: 'delivered' },
    { messageId: 'wamid.OUT1', status: 'read' },
  ]);
});
