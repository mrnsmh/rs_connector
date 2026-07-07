'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSession } = require('../src/session');

function buildMockDeps() {
  const sockEmitter = new EventEmitter();
  const mockSock = {
    ev: {
      on: (event, handler) => sockEmitter.on(event, handler),
      removeAllListeners: () => sockEmitter.removeAllListeners(),
    },
    ws: { close: () => {} },
  };

  const deps = {
    makeWASocket: () => mockSock,
    useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0], isLatest: true }),
    makeCacheableSignalKeyStore: (keys) => keys,
    DisconnectReason: { loggedOut: 401 },
    fs: { readdir: async () => [], rm: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  return { deps, sockEmitter };
}

test('un événement messages.update simulé déclenche onMessageStatusUpdate avec le bon statut traduit', async () => {
  const { deps, sockEmitter } = buildMockDeps();
  const received = [];

  const session = createSession(deps, '/tmp/test-auth', {
    autoReconnect: false,
    onMessageStatusUpdate: (payload) => { received.push(payload); },
  });

  await session.connect();

  // Simule un accusé DELIVERY_ACK (code 3) pour le message "MSG123".
  sockEmitter.emit('messages.update', [
    { key: { id: 'MSG123' }, update: { status: 3 } },
  ]);

  assert.equal(received.length, 1);
  assert.equal(received[0].messageId, 'MSG123');
  assert.equal(received[0].status, 'delivered');
  assert.equal(received[0].rawStatus, 3);
});

test('plusieurs accusés dans un même batch messages.update sont tous traités', async () => {
  const { deps, sockEmitter } = buildMockDeps();
  const received = [];

  const session = createSession(deps, '/tmp/test-auth', {
    autoReconnect: false,
    onMessageStatusUpdate: (payload) => { received.push(payload); },
  });

  await session.connect();

  sockEmitter.emit('messages.update', [
    { key: { id: 'MSG1' }, update: { status: 2 } }, // sent
    { key: { id: 'MSG2' }, update: { status: 3 } }, // delivered
    { key: { id: 'MSG3' }, update: { status: 4 } }, // read
  ]);

  assert.equal(received.length, 3);
  assert.deepEqual(received.map((r) => r.status), ['sent', 'delivered', 'read']);
});

test('un code de statut non pertinent (ex. PENDING) n\'invoque pas le callback', async () => {
  const { deps, sockEmitter } = buildMockDeps();
  const received = [];

  const session = createSession(deps, '/tmp/test-auth', {
    autoReconnect: false,
    onMessageStatusUpdate: (payload) => { received.push(payload); },
  });

  await session.connect();

  sockEmitter.emit('messages.update', [
    { key: { id: 'MSG1' }, update: { status: 1 } }, // PENDING, ignoré
  ]);

  assert.equal(received.length, 0);
});

test('sans callback onMessageStatusUpdate, l\'événement ne fait pas planter la session', async () => {
  const { deps, sockEmitter } = buildMockDeps();
  const session = createSession(deps, '/tmp/test-auth', { autoReconnect: false });

  await session.connect();

  assert.doesNotThrow(() => {
    sockEmitter.emit('messages.update', [{ key: { id: 'MSG1' }, update: { status: 3 } }]);
  });
});

test('onConnectionStateChange est appelé à chaque transition (qr, open, close)', async () => {
  const { deps, sockEmitter } = buildMockDeps();
  const changes = [];

  const session = createSession(deps, '/tmp/test-auth', {
    autoReconnect: false,
    onConnectionStateChange: (state) => { changes.push(state.status); },
  });

  await session.connect();
  sockEmitter.emit('connection.update', { qr: 'FAKE_QR' });
  sockEmitter.emit('connection.update', { connection: 'open' });
  sockEmitter.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });

  // Le handler 'close' avec logout est asynchrone (await clearAuthDir() avant de
  // notifier) : on laisse le microtask/macrotask se résoudre avant d'asserter.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(changes, ['qr_required', 'connected', 'logged_out']);
});
