'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Teste le câblage state-machine + DB + webhooks de connection-manager-factory.js en
 * important le VRAI code (buildMessageStatusHandler / buildConnectionStateHandler /
 * buildIncomingMessageHandler), et non une copie recopiée dans le test. Une régression
 * du câblage réel est donc désormais détectée par ces tests.
 */
const {
  buildMessageStatusHandler,
  buildConnectionStateHandler,
  buildIncomingMessageHandler,
} = require('../src/connection-manager-factory');

function buildMockDb() {
  const records = [];
  const anomalies = [];
  const connections = [];
  return {
    records,
    anomalies,
    connections,
    async recordMessageStatus({ connectionId, messageId, status }) {
      records.push({ connectionId, messageId, status });
    },
    async recordStatusAnomaly({ connectionId, messageId, fromStatus, attemptedStatus, reason }) {
      anomalies.push({ connectionId, messageId, fromStatus, attemptedStatus, reason });
    },
    async upsertConnection({ connectionId, status }) {
      connections.push({ connectionId, status });
    },
  };
}

function buildMockDispatcher() {
  const enqueued = [];
  return {
    enqueued,
    async enqueue(connectionId, eventType, payload) {
      enqueued.push({ connectionId, eventType, payload });
    },
  };
}

const silentLogger = { warn: () => {}, error: () => {}, info: () => {} };

// --- buildMessageStatusHandler (state machine + persistance + anomalies) ---

test('buildMessageStatusHandler : la branche failed -> retry -> sent est persistée dans l\'ordre', async () => {
  const db = buildMockDb();
  const handler = buildMessageStatusHandler({ db, lastStatusByMessage: new Map(), logger: silentLogger });

  await handler('b1', { messageId: 'm1', status: 'sent' });
  await handler('b1', { messageId: 'm1', status: 'failed' });
  await handler('b1', { messageId: 'm1', status: 'retry' });
  await handler('b1', { messageId: 'm1', status: 'sent' });

  assert.deepEqual(db.records.map((r) => r.status), ['sent', 'failed', 'retry', 'sent']);
});

test('buildMessageStatusHandler : une transition invalide (read -> sent) n\'écrit pas en messages_status', async () => {
  const db = buildMockDb();
  const handler = buildMessageStatusHandler({ db, lastStatusByMessage: new Map(), logger: silentLogger });

  await handler('b1', { messageId: 'm1', status: 'sent' });
  await handler('b1', { messageId: 'm1', status: 'read' });
  await handler('b1', { messageId: 'm1', status: 'sent' }); // invalide : read -> sent

  assert.deepEqual(db.records.map((r) => r.status), ['sent', 'read']);
});

test("CORRECTIF : une transition invalide est persistée comme anomalie (pas juste ignorée)", async () => {
  const db = buildMockDb();
  const handler = buildMessageStatusHandler({ db, lastStatusByMessage: new Map(), logger: silentLogger });

  await handler('b1', { messageId: 'm1', status: 'sent' });
  await handler('b1', { messageId: 'm1', status: 'read' });
  await handler('b1', { messageId: 'm1', status: 'sent' }); // invalide : read -> sent

  assert.equal(db.anomalies.length, 1);
  assert.equal(db.anomalies[0].messageId, 'm1');
  assert.equal(db.anomalies[0].fromStatus, 'read');
  assert.equal(db.anomalies[0].attemptedStatus, 'sent');
  assert.match(db.anomalies[0].reason, /Transition invalide/);
});

test('buildMessageStatusHandler : deux messages différents ont des historiques indépendants', async () => {
  const db = buildMockDb();
  const handler = buildMessageStatusHandler({ db, lastStatusByMessage: new Map(), logger: silentLogger });

  await handler('b1', { messageId: 'm1', status: 'sent' });
  await handler('b1', { messageId: 'm2', status: 'sent' });
  await handler('b1', { messageId: 'm1', status: 'delivered' });
  await handler('b1', { messageId: 'm2', status: 'failed' });

  const m1 = db.records.filter((r) => r.messageId === 'm1').map((r) => r.status);
  const m2 = db.records.filter((r) => r.messageId === 'm2').map((r) => r.status);
  assert.deepEqual(m1, ['sent', 'delivered']);
  assert.deepEqual(m2, ['sent', 'failed']);
});

test('buildMessageStatusHandler : une transition valide enqueue un webhook message.status_changed', async () => {
  const db = buildMockDb();
  const dispatcher = buildMockDispatcher();
  const handler = buildMessageStatusHandler({ db, webhookDispatcher: dispatcher, lastStatusByMessage: new Map(), logger: silentLogger });

  await handler('b1', { messageId: 'm1', status: 'sent' });
  await handler('b1', { messageId: 'm1', status: 'delivered' });

  assert.equal(dispatcher.enqueued.length, 2);
  assert.deepEqual(dispatcher.enqueued.map((e) => e.eventType), ['message.status_changed', 'message.status_changed']);
  assert.equal(dispatcher.enqueued[1].payload.status, 'delivered');
});

test('buildMessageStatusHandler : une transition invalide n\'enqueue AUCUN webhook', async () => {
  const db = buildMockDb();
  const dispatcher = buildMockDispatcher();
  const handler = buildMessageStatusHandler({ db, webhookDispatcher: dispatcher, lastStatusByMessage: new Map(), logger: silentLogger });

  await handler('b1', { messageId: 'm1', status: 'sent' });
  await handler('b1', { messageId: 'm1', status: 'read' });
  await handler('b1', { messageId: 'm1', status: 'sent' }); // invalide

  assert.equal(dispatcher.enqueued.length, 2); // sent + read seulement, pas la transition rejetée
});

test('buildMessageStatusHandler : retourne undefined sans DB (rien à persister)', () => {
  assert.equal(buildMessageStatusHandler({ lastStatusByMessage: new Map() }), undefined);
});

// --- buildConnectionStateHandler (persistance + webhooks connect/disconnect) ---

test('buildConnectionStateHandler : persiste chaque transition via upsertConnection', async () => {
  const db = buildMockDb();
  const handler = buildConnectionStateHandler({ db, lastConnectionStatusByConnection: new Map() });

  await handler('b1', { status: 'qr_required', qr: 'QR' });
  await handler('b1', { status: 'connected', qr: null });

  assert.deepEqual(db.connections.map((s) => s.status), ['qr_required', 'connected']);
});

test('buildConnectionStateHandler : enqueue session.connected une seule fois par transition réelle', async () => {
  const db = buildMockDb();
  const dispatcher = buildMockDispatcher();
  const last = new Map();
  const handler = buildConnectionStateHandler({ db, webhookDispatcher: dispatcher, lastConnectionStatusByConnection: last });

  await handler('b1', { status: 'connected', qr: null });
  await handler('b1', { status: 'connected', qr: null }); // même état répété : pas de nouveau webhook

  const connectedEvents = dispatcher.enqueued.filter((e) => e.eventType === 'session.connected');
  assert.equal(connectedEvents.length, 1);
});

test('buildConnectionStateHandler : session.disconnected uniquement si on venait de connected', async () => {
  const db = buildMockDb();
  const dispatcher = buildMockDispatcher();
  const last = new Map();
  const handler = buildConnectionStateHandler({ db, webhookDispatcher: dispatcher, lastConnectionStatusByConnection: last });

  await handler('b1', { status: 'connected', qr: null });
  await handler('b1', { status: 'logged_out', qr: null });

  const disconnected = dispatcher.enqueued.filter((e) => e.eventType === 'session.disconnected');
  assert.equal(disconnected.length, 1);
  assert.equal(disconnected[0].payload.status, 'logged_out');
});

test('buildConnectionStateHandler : possibly_banned sans passer par connected n\'enqueue pas session.disconnected', async () => {
  const db = buildMockDb();
  const dispatcher = buildMockDispatcher();
  const handler = buildConnectionStateHandler({ db, webhookDispatcher: dispatcher, lastConnectionStatusByConnection: new Map() });

  await handler('b1', { status: 'qr_required', qr: 'QR' });
  await handler('b1', { status: 'possibly_banned', qr: null });

  const disconnected = dispatcher.enqueued.filter((e) => e.eventType === 'session.disconnected');
  assert.equal(disconnected.length, 0);
});

// --- buildIncomingMessageHandler (webhook message.received) ---

test('buildIncomingMessageHandler : enqueue message.received avec le payload attendu', async () => {
  const dispatcher = buildMockDispatcher();
  const handler = buildIncomingMessageHandler({ webhookDispatcher: dispatcher });

  await handler('b1', { from: '212600000000@lid', messageId: 'in-1', text: 'Bonjour' });

  assert.equal(dispatcher.enqueued.length, 1);
  assert.equal(dispatcher.enqueued[0].eventType, 'message.received');
  assert.deepEqual(dispatcher.enqueued[0].payload, { connectionId: 'b1', from: '212600000000@lid', messageId: 'in-1', text: 'Bonjour' });
});

test('buildIncomingMessageHandler : retourne undefined sans dispatcher', () => {
  assert.equal(buildIncomingMessageHandler({}), undefined);
});
