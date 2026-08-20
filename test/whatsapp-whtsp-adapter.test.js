'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setWhtspModule, resetWhtspLoader } = require('../src/whtsp-loader');
const { createAdapter, channelType, capabilities } = require('../src/adapters/whatsapp-whtsp');
const { LidUnresolvedError } = require('../src/contact-resolver');

/**
 * Construit une fausse implémentation de `@whtsp/core` (injectée via setWhtspModule) :
 * aucun socket réel n'est jamais ouvert. L'emitter permet de déclencher les événements
 * connection.update / messages.upsert / messages.update depuis les tests.
 */
function buildFakeWhtsp() {
  const emitter = new EventEmitter();
  const calls = { createCount: 0, createOptions: null, sendJids: [], sendTexts: [] };
  const fakeState = {
    health: { risk: 'low', score: 0, reasons: [], uptime: 42, failedMessages: 0, successfulMessages: 1 },
    deliveryRate: 1,
    warmup: { day: 1 },
    rateLimit: {},
    paused: false,
    messages: { total: 1, blocked: 0, allowed: 1 },
  };
  const client = {
    antiBan: { getState: () => fakeState, pause: () => {}, resume: () => {} },
    sendText: async (jid, text) => {
      calls.sendJids.push(jid);
      calls.sendTexts.push(text);
      return { key: { id: 'mid-whtsp' } };
    },
    disconnect: async () => {},
    on: (event, handler) => emitter.on(event, handler),
    off: (event, handler) => emitter.off(event, handler),
    socket: { ev: { on: () => {} }, ws: { close: () => {} } },
  };
  const fakeModule = {
    createWhtspClient: async (opts) => {
      calls.createCount += 1;
      calls.createOptions = opts;
      return client;
    },
  };
  return { fakeModule, client, emitter, calls, fakeState };
}

function buildDeps() {
  const removed = [];
  const deps = {
    fs: {
      readdir: async () => ['creds.json'],
      readFile: async () => { throw new Error('ENOENT'); },
      rm: async (p) => { removed.push(p); },
    },
    db: { getContact: async () => null },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { deps, removed };
}

const AUTH_DIR = '/data/auth/conn-a';

test('whatsapp_whtsp expose le même contrat getState que session.js', async () => {
  const { fakeModule } = buildFakeWhtsp();
  setWhtspModule(fakeModule);
  try {
    const adapter = createAdapter(buildDeps().deps, AUTH_DIR, { connectionId: 'conn-a' });
    await adapter.connect();
    const state = adapter.getState();
    assert.equal(state.connected, false);
    assert.equal(state.status, 'connecting');
    assert.equal(state.authDir, AUTH_DIR);
    assert.equal(state.channelType, channelType);
    assert.equal(typeof state.reconnectAttempts, 'number');
  } finally {
    resetWhtspLoader();
  }
});

test('createWhtspClient reçoit authDir/sessionId reconstitués + browser override', async () => {
  const { fakeModule, calls } = buildFakeWhtsp();
  setWhtspModule(fakeModule);
  try {
    const adapter = createAdapter(buildDeps().deps, AUTH_DIR, {
      connectionId: 'conn-a',
      browser: ['Mac OS', 'Desktop', '14.4.1'],
      antibanConfig: { preset: 'maximum' },
    });
    await adapter.connect();
    assert.equal(calls.createCount, 1);
    assert.equal(calls.createOptions.config.authDir, '/data/auth');
    assert.equal(calls.createOptions.config.sessionId, 'conn-a');
    assert.equal(calls.createOptions.config.preset, 'maximum');
    assert.deepEqual(calls.createOptions.browser, ['Mac OS', 'Desktop', '14.4.1']);
  } finally {
    resetWhtspLoader();
  }
});

test('le QR émis par @whtsp/core expose le statut qr_required', async () => {
  const { fakeModule, emitter } = buildFakeWhtsp();
  setWhtspModule(fakeModule);
  try {
    const adapter = createAdapter(buildDeps().deps, AUTH_DIR, { connectionId: 'conn-a' });
    await adapter.connect();
    emitter.emit('connection.update', { connection: 'connecting', qr: 'FAKE_QR' });
    const state = adapter.getState();
    assert.equal(state.status, 'qr_required');
    assert.equal(state.qr, 'FAKE_QR');
    assert.ok(state.qrGeneratedAt);
  } finally {
    resetWhtspLoader();
  }
});

test('connection open → connected et réinitialise le compteur', async () => {
  const { fakeModule, emitter } = buildFakeWhtsp();
  setWhtspModule(fakeModule);
  try {
    const adapter = createAdapter(buildDeps().deps, AUTH_DIR, { connectionId: 'conn-a' });
    await adapter.connect();
    emitter.emit('connection.update', { connection: 'open' });
    const state = adapter.getState();
    assert.equal(state.connected, true);
    assert.equal(state.status, 'connected');
    assert.equal(state.reconnectAttempts, 0);
  } finally {
    resetWhtspLoader();
  }
});

test("déconnexion fatale (401) → logged_out + nettoyage du contenu de l'auth", async () => {
  const { fakeModule, emitter } = buildFakeWhtsp();
  setWhtspModule(fakeModule);
  const { deps, removed } = buildDeps();
  try {
    const adapter = createAdapter(deps, AUTH_DIR, { connectionId: 'conn-a' });
    await adapter.connect();
    emitter.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await new Promise((r) => setTimeout(r, 10));
    const state = adapter.getState();
    assert.equal(state.status, 'logged_out');
    assert.equal(state.lastDisconnectReason, 401);
    assert.ok(removed.length > 0, 'le contenu du dossier auth doit être purgé');
  } finally {
    resetWhtspLoader();
  }
});

test('déconnexion récupérable (500) → disconnected et compteur incrémenté', async () => {
  const { fakeModule, emitter } = buildFakeWhtsp();
  setWhtspModule(fakeModule);
  try {
    const adapter = createAdapter(buildDeps().deps, AUTH_DIR, { connectionId: 'conn-a' });
    await adapter.connect();
    emitter.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
    const state = adapter.getState();
    assert.equal(state.status, 'disconnected');
    assert.equal(state.reconnectAttempts, 1);
  } finally {
    resetWhtspLoader();
  }
});

test('sendMessage résout le numéro et passe par sendText (anti-ban)', async () => {
  const { fakeModule, calls } = buildFakeWhtsp();
  setWhtspModule(fakeModule);
  try {
    const adapter = createAdapter(buildDeps().deps, AUTH_DIR, { connectionId: 'conn-a' });
    await adapter.connect();
    const res = await adapter.sendMessage('+33612345678', 'Bonjour');
    assert.equal(calls.sendJids[0], '33612345678@s.whatsapp.net');
    assert.equal(calls.sendTexts[0], 'Bonjour');
    assert.equal(res.messageId, 'mid-whtsp');
  } finally {
    resetWhtspLoader();
  }
});

test('sendMessage vers un LID non résolu lève LidUnresolvedError (jamais de message fantôme)', async () => {
  const { fakeModule } = buildFakeWhtsp();
  setWhtspModule(fakeModule);
  try {
    const adapter = createAdapter(buildDeps().deps, AUTH_DIR, { connectionId: 'conn-a' });
    await adapter.connect();
    await assert.rejects(
      () => adapter.sendMessage('12345678901234567890@lid', 'Hello'),
      LidUnresolvedError,
    );
  } finally {
    resetWhtspLoader();
  }
});

test('messages.upsert notifie onIncomingMessage avec from/messageId/text', async () => {
  const { fakeModule, emitter } = buildFakeWhtsp();
  setWhtspModule(fakeModule);
  const received = [];
  try {
    const adapter = createAdapter(buildDeps().deps, AUTH_DIR, {
      connectionId: 'conn-a',
      onIncomingMessage: async (p) => received.push(p),
    });
    await adapter.connect();
    emitter.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '33612345678@s.whatsapp.net', id: 'in-1' }, message: { conversation: 'Salut' } }],
    });
    assert.equal(received.length, 1);
    assert.equal(received[0].from, '33612345678@s.whatsapp.net');
    assert.equal(received[0].messageId, 'in-1');
    assert.equal(received[0].text, 'Salut');
  } finally {
    resetWhtspLoader();
  }
});

test('messages.update remonte les accusés de statut mappés', async () => {
  const { fakeModule, emitter } = buildFakeWhtsp();
  setWhtspModule(fakeModule);
  const statuses = [];
  try {
    const adapter = createAdapter(buildDeps().deps, AUTH_DIR, {
      connectionId: 'conn-a',
      onMessageStatusUpdate: async (p) => statuses.push(p),
    });
    await adapter.connect();
    emitter.emit('messages.update', [
      { key: { id: 'out-1' }, update: { status: 2 } }, // SERVER_ACK → sent
      { key: { id: 'out-2' }, update: { status: 1 } }, // PENDING → ignoré
    ]);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].messageId, 'out-1');
    assert.equal(statuses[0].status, 'sent');
  } finally {
    resetWhtspLoader();
  }
});

test('antiBan.getState est exposé pour le health endpoint', async () => {
  const { fakeModule, fakeState } = buildFakeWhtsp();
  setWhtspModule(fakeModule);
  try {
    const adapter = createAdapter(buildDeps().deps, AUTH_DIR, { connectionId: 'conn-a' });
    await adapter.connect();
    assert.deepEqual(adapter.antiBan.getState(), fakeState);
    assert.equal(adapter.antiBan.getState().health.risk, 'low');
  } finally {
    resetWhtspLoader();
  }
});

test('channelType et capabilities du canal whtsp', () => {
  assert.equal(channelType, 'whatsapp_whtsp');
  assert.equal(capabilities.antiBan, true);
  assert.equal(capabilities.statusReceipts, true);
});

