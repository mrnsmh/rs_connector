'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSession, DEFAULT_POSSIBLY_BANNED_THRESHOLD } = require('../src/session');

/**
 * Construit un jeu de dépendances Baileys entièrement mocké : aucun socket réel n'est
 * jamais ouvert. `sockEmitter` permet de déclencher manuellement des événements
 * connection.update / creds.update depuis les tests.
 */
function buildMockDeps({ registered = false } = {}) {
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
    useMultiFileAuthState: async () => ({
      state: { creds: registered ? { registered: true } : {}, keys: {} },
      saveCreds: async () => {},
    }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0], isLatest: true }),
    makeCacheableSignalKeyStore: (keys) => keys,
    DisconnectReason: { loggedOut: 401 },
    fs: {
      readdir: async () => [],
      rm: async () => {},
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };

  return { deps, sockEmitter };
}

test('connect() initialise un socket sans lever d\'exception (Baileys mocké)', async () => {
  const { deps } = buildMockDeps();
  const session = createSession(deps, '/tmp/test-auth', { autoReconnect: false });

  await assert.doesNotReject(() => session.connect());
  assert.equal(session.getState().authDir, '/tmp/test-auth');
});

test('le QR code émis par connection.update est bien exposé via getState()', async () => {
  const { deps, sockEmitter } = buildMockDeps();
  const session = createSession(deps, '/tmp/test-auth', { autoReconnect: false });

  await session.connect();
  sockEmitter.emit('connection.update', { qr: 'FAKE_QR_DATA' });

  const state = session.getState();
  assert.equal(state.status, 'qr_required');
  assert.equal(state.qr, 'FAKE_QR_DATA');
  assert.ok(state.qrGeneratedAt);
});

test('connection === open remet le statut à connected et réinitialise le compteur', async () => {
  const { deps, sockEmitter } = buildMockDeps();
  const session = createSession(deps, '/tmp/test-auth', { autoReconnect: false });

  await session.connect();
  sockEmitter.emit('connection.update', { connection: 'open' });

  const state = session.getState();
  assert.equal(state.connected, true);
  assert.equal(state.status, 'connected');
  assert.equal(state.reconnectAttempts, 0);
});

test('logout (401) déclenche le nettoyage de l\'auth et réinitialise le compteur', async () => {
  const { deps, sockEmitter } = buildMockDeps();
  const session = createSession(deps, '/tmp/test-auth', { autoReconnect: false });

  await session.connect();
  sockEmitter.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });

  const state = session.getState();
  assert.equal(state.status, 'logged_out');
  assert.equal(state.reconnectAttempts, 0);
});

test('bascule vers possibly_banned après N échecs de reconnexion consécutifs', async () => {
  const { deps, sockEmitter } = buildMockDeps({ registered: true });
  const threshold = 3;
  const session = createSession(deps, '/tmp/test-auth', { possiblyBannedThreshold: threshold, autoReconnect: false });

  await session.connect();

  // Simule des fermetures non-logout répétées (ex. erreur réseau/serveur), sans jamais
  // atteindre 'open' entre les deux — comme un numéro qui ne peut plus se reconnecter.
  for (let i = 0; i < threshold - 1; i++) {
    sockEmitter.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
  }
  let state = session.getState();
  assert.equal(state.status, 'disconnected');
  assert.equal(state.reconnectAttempts, threshold - 1);

  sockEmitter.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 500 } } },
  });

  state = session.getState();
  assert.equal(state.status, 'possibly_banned');
  assert.equal(state.reconnectAttempts, threshold);
});

test('le seuil par défaut est appliqué si aucune option n\'est fournie', async () => {
  const { deps, sockEmitter } = buildMockDeps({ registered: true });
  const session = createSession(deps, '/tmp/test-auth', { autoReconnect: false });

  await session.connect();

  for (let i = 0; i < DEFAULT_POSSIBLY_BANNED_THRESHOLD - 1; i++) {
    sockEmitter.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
  }
  assert.equal(session.getState().status, 'disconnected');

  sockEmitter.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 500 } } },
  });
  assert.equal(session.getState().status, 'possibly_banned');
});

test('appairage en cours (non enregistré) : les timeouts 408 ne déclenchent PAS possibly_banned', async () => {
  const { deps, sockEmitter } = buildMockDeps({ registered: false });
  const threshold = 3;
  const session = createSession(deps, '/tmp/test-auth', { possiblyBannedThreshold: threshold, autoReconnect: false });

  await session.connect();
  sockEmitter.emit('connection.update', { qr: 'QR_EN_ATTENTE_DE_SCAN' });

  // Fermetures répétées par timeout (408) pendant l'attente du scan, au-delà du seuil :
  for (let i = 0; i < threshold + 2; i++) {
    sockEmitter.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
  }

  const state = session.getState();
  assert.notEqual(state.status, 'possibly_banned', "l'appairage ne doit jamais être qualifié de bannissement");
  assert.equal(state.status, 'qr_required', 'reste en attente de scan tant que non enregistré');
});
