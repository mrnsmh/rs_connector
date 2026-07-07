'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter, channelType, capabilities } = require('../src/adapters/telegram');

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Mock fetch-like : route par méthode d'API Telegram (dernier segment de l'URL après le
 * token) et retourne un objet { json: async () => <réponse> }. Enregistre les appels.
 */
function buildMockFetch(handlers) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    const method = String(url).split('/bot')[1].split('/')[1];
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    calls.push({ method, body });
    const handler = handlers[method];
    const response = handler ? handler(body) : { ok: false, description: `no handler for ${method}` };
    return { json: async () => response };
  };
  return { fetchFn, calls };
}

test('capabilities et channelType du canal Telegram', () => {
  assert.equal(channelType, 'telegram');
  assert.equal(capabilities.auth, 'token');
  assert.equal(capabilities.inbound, true);
  assert.equal(capabilities.outbound, true);
  assert.equal(capabilities.statusReceipts, false);
});

test('connect() valide le token via getMe et passe à connected', async () => {
  const { fetchFn } = buildMockFetch({ getMe: () => ({ ok: true, result: { id: 1, is_bot: true, username: 'mybot' } }) });
  const states = [];
  const adapter = createAdapter(
    { fetchFn, logger: silentLogger },
    '/tmp',
    { connectionId: 'c1', token: 'TOK', autoPoll: false, onConnectionStateChange: (s) => states.push(s.status) },
  );
  await adapter.connect();
  assert.equal(adapter.isConnected(), true);
  assert.equal(adapter.getState().status, 'connected');
  assert.equal(adapter.getState().username, 'mybot');
  assert.deepEqual(states, ['connected']);
});

test('connect() avec un token invalide (getMe ok:false) passe en error', async () => {
  const { fetchFn } = buildMockFetch({ getMe: () => ({ ok: false, description: 'Unauthorized' }) });
  const adapter = createAdapter({ fetchFn, logger: silentLogger }, '/tmp', { token: 'BAD', autoPoll: false });
  await adapter.connect();
  assert.equal(adapter.getState().status, 'error');
  assert.equal(adapter.isConnected(), false);
});

test('connect() sans token passe en error sans appeler le réseau', async () => {
  let fetchCalled = false;
  const fetchFn = async () => { fetchCalled = true; return { json: async () => ({ ok: true }) }; };
  const adapter = createAdapter({ fetchFn, logger: silentLogger }, '/tmp', { autoPoll: false });
  await adapter.connect();
  assert.equal(adapter.getState().status, 'error');
  assert.equal(fetchCalled, false);
});

test('sendMessage poste vers sendMessage et retourne le message_id', async () => {
  const { fetchFn, calls } = buildMockFetch({
    getMe: () => ({ ok: true, result: { username: 'b' } }),
    sendMessage: (body) => ({ ok: true, result: { message_id: 42, chat: { id: body.chat_id } } }),
  });
  const adapter = createAdapter({ fetchFn, logger: silentLogger }, '/tmp', { token: 'TOK', autoPoll: false });
  await adapter.connect();
  const res = await adapter.sendMessage('123456', 'bonjour');
  assert.equal(res.messageId, '42');
  assert.equal(res.to, '123456');
  const sent = calls.find((c) => c.method === 'sendMessage');
  assert.equal(sent.body.chat_id, '123456');
  assert.equal(sent.body.text, 'bonjour');
});

test('pollOnce() remonte les messages entrants et avance l\'offset', async () => {
  const incoming = [];
  let getUpdatesCalls = 0;
  const fetchFn = async (url, opts) => {
    const method = String(url).split('/bot')[1].split('/')[1];
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (method === 'getMe') return { json: async () => ({ ok: true, result: { username: 'b' } }) };
    if (method === 'getUpdates') {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return { json: async () => ({ ok: true, result: [
          { update_id: 10, message: { message_id: 5, chat: { id: 999 }, text: 'salut' } },
        ] }) };
      }
      // Deuxième appel : vérifie que l'offset a bien avancé à 11.
      assert.equal(body.offset, 11);
      return { json: async () => ({ ok: true, result: [] }) };
    }
    return { json: async () => ({ ok: false }) };
  };
  const adapter = createAdapter(
    { fetchFn, logger: silentLogger },
    '/tmp',
    { token: 'TOK', autoPoll: false, onIncomingMessage: (m) => incoming.push(m) },
  );
  await adapter.connect();

  const n1 = await adapter._internal.pollOnce();
  assert.equal(n1, 1);
  assert.equal(incoming.length, 1);
  assert.deepEqual(incoming[0], { from: '999', messageId: '5', text: 'salut' });

  const n2 = await adapter._internal.pollOnce();
  assert.equal(n2, 0);
});

test('le registre d\'adaptateurs expose le canal telegram', () => {
  const registry = require('../src/adapters');
  const adapter = registry.getAdapter('telegram');
  assert.ok(adapter);
  assert.equal(adapter.channelType, 'telegram');
  assert.ok(registry.listChannelTypes().includes('telegram'));
  assert.ok(registry.listChannelTypes().includes('whatsapp_baileys'));
});
