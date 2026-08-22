'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSession, UNPAIRED_MAX_AUTO_RECONNECTS } = require('../src/session');

/**
 * Mock Baileys avec socket VIVANT (ws.readyState = 1) et support requestPairingCode.
 * Compte les créations de sockets pour vérifier que connect() ne recrée pas un socket
 * vivant en attente d'appairage (sinon chaque sondage GET /qr invaliderait le QR affiché).
 */
function buildPairingDeps({ registered = false, pairingCode = 'ABCD-1234' } = {}) {
  let socketCount = 0;
  const emitters = [];
  const requestPairingCalls = [];

  const deps = {
    makeWASocket: () => {
      socketCount += 1;
      const sockEmitter = new EventEmitter();
      emitters.push(sockEmitter);
      const mockSock = {
        ev: {
          on: (event, handler) => sockEmitter.on(event, handler),
          removeAllListeners: () => sockEmitter.removeAllListeners(),
        },
        ws: { readyState: 1, close: () => {} },
        requestPairingCode: async (phone) => {
          requestPairingCalls.push(phone);
          return pairingCode;
        },
      };
      return mockSock;
    },
    useMultiFileAuthState: async () => ({
      state: { creds: registered ? { registered: true } : {}, keys: {} },
      saveCreds: async () => {},
    }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0], isLatest: true }),
    makeCacheableSignalKeyStore: (keys) => keys,
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    fs: { readdir: async () => [], rm: async () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };

  return {
    deps,
    emitters,
    requestPairingCalls,
    socketCount: () => socketCount,
  };
}

test('requestPairingCode retourne le code et expose pairingCode dans getState', async () => {
  const { deps } = buildPairingDeps();
  const session = createSession(deps, '/tmp/test-auth-pair', {});

  await session.connect();
  const code = await session.requestPairingCode('212612345678');

  assert.equal(code, 'ABCD-1234');
  const state = session.getState();
  assert.equal(state.status, 'pairing_code_sent');
  assert.equal(state.pairingCode, 'ABCD-1234');
  assert.ok(state.pairingCodeAt);
});

test('requestPairingCode rejette un numéro invalide (400)', async () => {
  const { deps } = buildPairingDeps();
  const session = createSession(deps, '/tmp/test-auth-pair', {});
  await session.connect();

  await assert.rejects(
    () => session.requestPairingCode('abc-12'),
    (err) => err.statusCode === 400,
  );
});

test('requestPairingCode refuse une session déjà appairée (409)', async () => {
  const { deps } = buildPairingDeps({ registered: true });
  const session = createSession(deps, '/tmp/test-auth-pair', {});
  await session.connect();

  await assert.rejects(
    () => session.requestPairingCode('212612345678'),
    (err) => err.statusCode === 409,
  );
});

test('connect() NE recrée PAS le socket tant qu\u2019il est vivant et en attente d\u2019appairage', async () => {
  const { deps, emitters, socketCount } = buildPairingDeps();
  const session = createSession(deps, '/tmp/test-auth-pair', {});

  await session.connect();
  emitters[0].emit('connection.update', { qr: 'QR_1' });
  assert.equal(session.getState().status, 'qr_required');

  // Sondages répétés (comme le front DeskManager) : aucun nouveau socket ne doit
  // être créé — sinon le QR affiché serait invalidé avant d'avoir été scanné.
  for (let i = 0; i < 5; i++) {
    await session.connect();
  }
  assert.equal(socketCount(), 1, 'le socket vivant en attente de scan doit être conservé');
  assert.equal(session.getState().qr, 'QR_1', 'le QR affiché doit rester valide');

  // force=true (régénération explicite) crée bien un nouveau socket :
  await session.connect({ force: true });
  assert.equal(socketCount(), 2);
});

test('après expiration du QR (qr_expired), connect() repart sur un socket frais', async () => {
  const { deps, emitters, socketCount } = buildPairingDeps();
  const session = createSession(deps, '/tmp/test-auth-pair', { autoReconnect: false });

  await session.connect();
  emitters[0].emit('connection.update', { qr: 'QR_MORT' });

  // Épuise les tentatives pré-appairage → qr_expired :
  for (let i = 0; i < UNPAIRED_MAX_AUTO_RECONNECTS + 2; i++) {
    emitters[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 }, message: 'QR refs attempts ended' } },
    });
  }
  assert.equal(session.getState().status, 'qr_expired');

  // Un nouvel appel connect() (sondage front ou clic « Nouveau QR ») redémarre proprement :
  await session.connect();
  assert.ok(socketCount() > 1, 'un nouveau socket doit être créé après expiration');
  assert.equal(session.getState().status, 'connecting');
});
