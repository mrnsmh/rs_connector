'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter, channelType, capabilities } = require('../src/adapters/email');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Fabriques mockées au contrat attendu par l'adaptateur (createMailer / createMailReceiver),
 * pour tester sans vrai serveur mail.
 */
function buildMocks({ verifyOk = true, sendResult = { messageId: '<mid@host>' }, unseen = [] } = {}) {
  const sent = [];
  let receiverClosed = false;
  const createMailer = () => ({
    verify: async () => {
      if (!verifyOk) throw new Error('SMTP auth failed');
      return true;
    },
    sendMail: async (msg) => { sent.push(msg); return sendResult; },
  });
  const createMailReceiver = () => ({
    connect: async () => {},
    fetchUnseen: async () => unseen,
    close: async () => { receiverClosed = true; },
  });
  return { createMailer, createMailReceiver, sent, isReceiverClosed: () => receiverClosed };
}

const smtp = { host: 'smtp.example.com', port: 465, secure: true, user: 'bot@example.com', pass: 'secret' };
const imap = { host: 'imap.example.com', port: 993, secure: true, user: 'bot@example.com', pass: 'secret' };

test('capabilities et channelType du canal Email', () => {
  assert.equal(channelType, 'email');
  assert.equal(capabilities.auth, 'smtp_imap');
  assert.equal(capabilities.inbound, true);
  assert.equal(capabilities.outbound, true);
  assert.equal(capabilities.statusReceipts, false);
});

test('connect() vérifie le SMTP et connecte l\'IMAP → connected', async () => {
  const mocks = buildMocks();
  const states = [];
  const adapter = createAdapter(mocks, '/tmp', {
    connectionId: 'e1',
    credentials: { smtp, imap },
    autoPoll: false,
    onConnectionStateChange: (s) => states.push(s.status),
  });
  await adapter.connect();
  assert.equal(adapter.isConnected(), true);
  assert.equal(adapter.getState().status, 'connected');
  assert.equal(adapter.getState().from, 'bot@example.com');
  assert.deepEqual(states, ['connected']);
});

test('connect() passe en error si la vérification SMTP échoue', async () => {
  const mocks = buildMocks({ verifyOk: false });
  const adapter = createAdapter(mocks, '/tmp', { credentials: { smtp, imap }, autoPoll: false });
  await adapter.connect();
  assert.equal(adapter.getState().status, 'error');
});

test('connect() sans configuration SMTP passe en error', async () => {
  const mocks = buildMocks();
  const adapter = createAdapter(mocks, '/tmp', { credentials: { imap }, autoPoll: false });
  await adapter.connect();
  assert.equal(adapter.getState().status, 'error');
});

test('connexion en envoi seul (SMTP sans IMAP) → connected, pollOnce ne fait rien', async () => {
  const mocks = buildMocks();
  const adapter = createAdapter(mocks, '/tmp', { credentials: { smtp }, autoPoll: false });
  await adapter.connect();
  assert.equal(adapter.getState().status, 'connected');
  const n = await adapter._internal.pollOnce();
  assert.equal(n, 0);
});

test('sendMessage envoie un email (from/to/subject/text) et retourne le messageId', async () => {
  const mocks = buildMocks({ sendResult: { messageId: '<abc@srv>' } });
  const adapter = createAdapter(mocks, '/tmp', {
    credentials: { smtp, imap },
    autoPoll: false,
    defaultSubject: 'rs-connector',
  });
  await adapter.connect();
  const res = await adapter.sendMessage('client@ext.com', 'Bonjour !');
  assert.equal(res.messageId, '<abc@srv>');
  assert.equal(res.to, 'client@ext.com');
  assert.equal(mocks.sent.length, 1);
  assert.equal(mocks.sent[0].from, 'bot@example.com');
  assert.equal(mocks.sent[0].to, 'client@ext.com');
  assert.equal(mocks.sent[0].subject, 'rs-connector');
  assert.equal(mocks.sent[0].text, 'Bonjour !');
});

test('pollOnce() remonte les emails non lus via onIncomingMessage', async () => {
  const unseen = [
    { messageId: '101', from: 'a@ext.com', subject: 'Devis', text: 'Bonjour, un devis svp' },
    { messageId: '102', from: 'b@ext.com', subject: 'Info', text: 'Question' },
  ];
  const incoming = [];
  const mocks = buildMocks({ unseen });
  const adapter = createAdapter(mocks, '/tmp', {
    credentials: { smtp, imap },
    autoPoll: false,
    onIncomingMessage: (m) => incoming.push(m),
  });
  await adapter.connect();
  const n = await adapter._internal.pollOnce();
  assert.equal(n, 2);
  assert.equal(incoming.length, 2);
  assert.deepEqual(incoming[0], { from: 'a@ext.com', messageId: '101', text: 'Bonjour, un devis svp', subject: 'Devis' });
});

test('disconnect() ferme le receiver IMAP', async () => {
  const mocks = buildMocks();
  const adapter = createAdapter(mocks, '/tmp', { credentials: { smtp, imap }, autoPoll: false });
  await adapter.connect();
  await adapter.disconnect();
  assert.equal(adapter.getState().status, 'disconnected');
  assert.equal(mocks.isReceiverClosed(), true);
});

test('le registre d\'adaptateurs expose le canal email', () => {
  const registry = require('../src/adapters');
  const adapter = registry.getAdapter('email');
  assert.ok(adapter);
  assert.equal(adapter.channelType, 'email');
  const channels = registry.listChannelTypes();
  assert.ok(channels.includes('email'));
  assert.ok(channels.includes('telegram'));
  assert.ok(channels.includes('whatsapp_baileys'));
});
