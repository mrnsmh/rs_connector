'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSession } = require('../src/session');
const { createConnectionManager } = require('../src/connection-manager');

function buildMockSessionDeps() {
  const createdSockets = []; // trace de tous les sockets créés, dans l'ordre d'appel de makeWASocket

  const deps = {
    makeWASocket: () => {
      const emitter = new EventEmitter();
      const sock = {
        ev: {
          on: (event, handler) => emitter.on(event, handler),
          removeAllListeners: () => emitter.removeAllListeners(),
        },
        ws: { close: () => {} },
        _emitter: emitter,
      };
      createdSockets.push(sock);
      return sock;
    },
    useMultiFileAuthState: async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: async () => {},
    }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0], isLatest: true }),
    makeCacheableSignalKeyStore: (keys) => keys,
    DisconnectReason: { loggedOut: 401 },
    fs: { readdir: async () => [], rm: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };

  return { deps, createdSockets };
}

test('deux connections distinctes ont des répertoires d\'auth isolés', async () => {
  const { deps: sessionDeps } = buildMockSessionDeps();
  const manager = createConnectionManager({
    createSession,
    baseAuthDir: '/data/auth',
    joinPath: (...parts) => parts.join('/'),
    sessionDeps,
  });

  const sessionA = await manager.getOrCreate('connexion-a', { autoReconnect: false });
  const sessionB = await manager.getOrCreate('connexion-b', { autoReconnect: false });

  await sessionA.connect();
  await sessionB.connect();

  assert.equal(sessionA.getState().authDir, '/data/auth/connexion-a');
  assert.equal(sessionB.getState().authDir, '/data/auth/connexion-b');
  assert.notEqual(sessionA, sessionB);
});

test('déconnecter une session n\'affecte pas l\'état de l\'autre', async () => {
  const { deps: sessionDeps, createdSockets } = buildMockSessionDeps();
  const manager = createConnectionManager({
    createSession,
    baseAuthDir: '/data/auth',
    joinPath: (...parts) => parts.join('/'),
    sessionDeps,
  });

  const sessionA = await manager.getOrCreate('connexion-a', { autoReconnect: false });
  const sessionB = await manager.getOrCreate('connexion-b', { autoReconnect: false });

  await sessionA.connect();
  await sessionB.connect();

  // Les deux connect() ont créé un socket chacun, dans l'ordre : [socketA, socketB].
  const [socketA, socketB] = createdSockets;

  // Les deux connections passent d'abord à connected.
  socketA._emitter.emit('connection.update', { connection: 'open' });
  socketB._emitter.emit('connection.update', { connection: 'open' });
  assert.equal(sessionA.isConnected(), true);
  assert.equal(sessionB.isConnected(), true);

  // Logout (401) sur A UNIQUEMENT : B doit rester connectée, totalement inchangée.
  socketA._emitter.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });

  assert.equal(sessionA.getState().status, 'logged_out');
  assert.equal(sessionB.getState().status, 'connected');
  assert.equal(sessionB.isConnected(), true);
});

test('getOrCreate est idempotent : ne recrée pas une session existante pour la même connexion', async () => {
  const { deps: sessionDeps } = buildMockSessionDeps();
  const manager = createConnectionManager({
    createSession,
    baseAuthDir: '/data/auth',
    joinPath: (...parts) => parts.join('/'),
    sessionDeps,
  });

  const first = await manager.getOrCreate('connexion-a', { autoReconnect: false });
  const second = await manager.getOrCreate('connexion-a', { autoReconnect: false });

  assert.equal(first, second);
  assert.deepEqual(manager.list(), ['connexion-a']);
});

test('list() et getAllStates() reflètent toutes les connexions enregistrées', async () => {
  const { deps: sessionDeps } = buildMockSessionDeps();
  const manager = createConnectionManager({
    createSession,
    baseAuthDir: '/data/auth',
    joinPath: (...parts) => parts.join('/'),
    sessionDeps,
  });

  await manager.getOrCreate('connexion-a', { autoReconnect: false });
  await manager.getOrCreate('connexion-b', { autoReconnect: false });

  const list = manager.list().sort();
  assert.deepEqual(list, ['connexion-a', 'connexion-b']);

  const states = manager.getAllStates();
  assert.ok(states['connexion-a']);
  assert.ok(states['connexion-b']);
});

test('remove() retire bien une session de la liste', async () => {
  const { deps: sessionDeps } = buildMockSessionDeps();
  const manager = createConnectionManager({
    createSession,
    baseAuthDir: '/data/auth',
    joinPath: (...parts) => parts.join('/'),
    sessionDeps,
  });

  await manager.getOrCreate('connexion-a', { autoReconnect: false });
  assert.equal(manager.remove('connexion-a'), true);
  assert.equal(manager.get('connexion-a'), null);
});

test('getOrCreate() sans connection_id lève une erreur explicite', async () => {
  const { deps: sessionDeps } = buildMockSessionDeps();
  const manager = createConnectionManager({
    createSession,
    baseAuthDir: '/data/auth',
    joinPath: (...parts) => parts.join('/'),
    sessionDeps,
  });

  await assert.rejects(() => manager.getOrCreate(''), /connection_id requis/);
});
