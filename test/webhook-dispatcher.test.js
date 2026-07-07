'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebhookDispatcher } = require('../src/webhook-dispatcher');
const { createWebhookSigner } = require('../src/webhook-signer');
const crypto = require('node:crypto');

/**
 * DB en mémoire minimale, reproduisant exactement le contrat de db.js pour l'outbox
 * (enqueueWebhook, getPendingWebhooks, markWebhookSent, markWebhookFailed), sans
 * dépendre d'une vraie connexion Postgres.
 */
function buildMockDb() {
  const rows = new Map();
  let nextId = 1;
  return {
    rows,
    async enqueueWebhook({ connectionId, eventType, payload }) {
      const row = {
        id: nextId++,
        connection_id: connectionId,
        event_type: eventType,
        payload,
        status: 'pending',
        attempts: 0,
        next_retry_at: new Date(0), // dû immédiatement par défaut
        last_error: null,
      };
      rows.set(row.id, row);
      return row;
    },
    async getPendingWebhooks(limit = 50) {
      const now = Date.now();
      return Array.from(rows.values())
        .filter((r) => r.status === 'pending' && new Date(r.next_retry_at).getTime() <= now)
        .slice(0, limit);
    },
    async markWebhookSent(id) {
      const row = rows.get(id);
      if (row) row.status = 'sent';
      return row;
    },
    async markWebhookFailed(id, { reason, nextRetryAt, permanent }) {
      const row = rows.get(id);
      if (row) {
        row.attempts += 1;
        row.status = permanent ? 'failed_permanent' : 'pending';
        row.next_retry_at = nextRetryAt;
        row.last_error = reason;
      }
      return row;
    },
  };
}

function buildFakeFetch(responses) {
  // `responses` est une file de réponses/erreurs à retourner successivement.
  let calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next || { ok: true, status: 200 };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

function buildConnectionConfig(entries) {
  return new Map(Object.entries(entries));
}

test('enqueue() écrit TOUJOURS en DB avant tout envoi HTTP (aucun fetch appelé)', async () => {
  const db = buildMockDb();
  const fetchFn = buildFakeFetch([]);
  const dispatcher = createWebhookDispatcher({
    db, webhookSigner: createWebhookSigner({ crypto }), fetchFn, logger: { warn() {}, error() {} },
  });

  await dispatcher.enqueue('b1', 'message.received', { text: 'hello' });

  assert.equal(db.rows.size, 1);
  assert.equal(fetchFn.calls.length, 0);
});

test('processQueue() livre avec succès un webhook pending et le marque sent', async () => {
  const db = buildMockDb();
  const fetchFn = buildFakeFetch([{ ok: true, status: 200 }]);
  const signer = createWebhookSigner({ crypto });
  const dispatcher = createWebhookDispatcher({ db, webhookSigner: signer, fetchFn, logger: { warn() {}, error() {} } });

  await dispatcher.enqueue('b1', 'message.received', { text: 'hello' });
  const config = buildConnectionConfig({ b1: { webhookUrl: 'https://example.com/hook', secret: 'my-secret' } });

  const result = await dispatcher.processQueue(config);

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(Array.from(db.rows.values())[0].status, 'sent');
});

test('le webhook envoyé inclut une signature HMAC valide dans le header X-Webhook-Signature', async () => {
  const db = buildMockDb();
  const fetchFn = buildFakeFetch([{ ok: true, status: 200 }]);
  const signer = createWebhookSigner({ crypto });
  const dispatcher = createWebhookDispatcher({ db, webhookSigner: signer, fetchFn, logger: { warn() {}, error() {} } });

  await dispatcher.enqueue('b1', 'message.received', { text: 'hello' });
  const config = buildConnectionConfig({ b1: { webhookUrl: 'https://example.com/hook', secret: 'my-secret' } });
  await dispatcher.processQueue(config);

  const call = fetchFn.calls[0];
  const signature = call.options.headers['X-Webhook-Signature'];
  assert.equal(signer.verify(call.options.body, 'my-secret', signature), true);
});

test('CORRECTIF : un échec réseau planifie un retry avec backoff (pas de perte, statut reste pending)', async () => {
  const db = buildMockDb();
  const fetchFn = buildFakeFetch([new Error('ECONNREFUSED')]);
  const now = () => 1_000_000;
  const dispatcher = createWebhookDispatcher(
    { db, webhookSigner: createWebhookSigner({ crypto }), fetchFn, logger: { warn() {}, error() {} }, now },
    { baseDelayMs: 2000, maxAttempts: 5 },
  );

  await dispatcher.enqueue('b1', 'message.received', { text: 'hello' });
  const config = buildConnectionConfig({ b1: { webhookUrl: 'https://example.com/hook', secret: 's' } });

  const result = await dispatcher.processQueue(config);

  assert.equal(result.failed, 1);
  const row = Array.from(db.rows.values())[0];
  assert.equal(row.status, 'pending'); // pas perdu, toujours pending pour retry
  assert.equal(row.attempts, 1);
  assert.equal(new Date(row.next_retry_at).getTime(), now() + 2000 * 2 ** 0);
});

test('après maxAttempts échecs consécutifs, le webhook bascule en failed_permanent', async () => {
  const db = buildMockDb();
  const fetchFn = buildFakeFetch([
    new Error('fail-1'), new Error('fail-2'), new Error('fail-3'),
  ]);
  const dispatcher = createWebhookDispatcher(
    { db, webhookSigner: createWebhookSigner({ crypto }), fetchFn, logger: { warn() {}, error() {} } },
    { maxAttempts: 3, baseDelayMs: 1 },
  );

  await dispatcher.enqueue('b1', 'message.received', { text: 'hello' });
  const config = buildConnectionConfig({ b1: { webhookUrl: 'https://example.com/hook', secret: 's' } });

  // 3 passages successifs, chacun échoue.
  await dispatcher.processQueue(config);
  const row = Array.from(db.rows.values())[0];
  row.next_retry_at = new Date(0); // force la disponibilité immédiate pour le prochain passage
  await dispatcher.processQueue(config);
  row.next_retry_at = new Date(0);
  await dispatcher.processQueue(config);

  assert.equal(row.status, 'failed_permanent');
  assert.equal(row.attempts, 3);
});

test("CORRECTIF : survie à un 'crash' simulé — recréer le dispatcher avec le même mock db retrouve le webhook toujours pending", async () => {
  const db = buildMockDb();
  const fetchFn1 = buildFakeFetch([new Error('ECONNREFUSED')]);
  const dispatcher1 = createWebhookDispatcher({ db, webhookSigner: createWebhookSigner({ crypto }), fetchFn: fetchFn1, logger: { warn() {}, error() {} } });

  await dispatcher1.enqueue('b1', 'message.received', { text: 'hello' });
  const config = buildConnectionConfig({ b1: { webhookUrl: 'https://example.com/hook', secret: 's' } });
  await dispatcher1.processQueue(config); // échoue, reste pending

  // Simule un "crash" : dispatcher1 est abandonné (aucune promesse en mémoire réutilisée),
  // un nouveau dispatcher est recréé avec le MÊME mock db (représentant la DB persistante
  // qui, elle, survit à un redémarrage réel du conteneur).
  const row = Array.from(db.rows.values())[0];
  row.next_retry_at = new Date(0); // force la disponibilité immédiate pour ce test
  const fetchFn2 = buildFakeFetch([{ ok: true, status: 200 }]);
  const dispatcher2 = createWebhookDispatcher({ db, webhookSigner: createWebhookSigner({ crypto }), fetchFn: fetchFn2, logger: { warn() {}, error() {} } });

  const result = await dispatcher2.processQueue(config);

  assert.equal(result.sent, 1);
  assert.equal(row.status, 'sent'); // aucune perte malgré le "crash" entre les deux tentatives
});

test('un événement sans URL webhook configurée pour sa connexion est repoussé (pas compté comme échec réseau)', async () => {
  const db = buildMockDb();
  const fetchFn = buildFakeFetch([]);
  const dispatcher = createWebhookDispatcher({ db, webhookSigner: createWebhookSigner({ crypto }), fetchFn, logger: { warn() {}, error() {} } });

  await dispatcher.enqueue('b1', 'message.received', { text: 'hello' });
  const config = buildConnectionConfig({}); // aucune config pour b1

  const result = await dispatcher.processQueue(config);

  assert.equal(result.skipped, 1);
  assert.equal(fetchFn.calls.length, 0);
  const row = Array.from(db.rows.values())[0];
  assert.equal(row.status, 'pending'); // pas perdu, juste repoussé
});

test('une réponse HTTP non-ok (ex. 500) est traitée comme un échec (retry planifié)', async () => {
  const db = buildMockDb();
  const fetchFn = buildFakeFetch([{ ok: false, status: 500 }]);
  const dispatcher = createWebhookDispatcher({ db, webhookSigner: createWebhookSigner({ crypto }), fetchFn, logger: { warn() {}, error() {} } });

  await dispatcher.enqueue('b1', 'message.received', { text: 'hello' });
  const config = buildConnectionConfig({ b1: { webhookUrl: 'https://example.com/hook', secret: 's' } });

  const result = await dispatcher.processQueue(config);

  assert.equal(result.failed, 1);
  const row = Array.from(db.rows.values())[0];
  assert.equal(row.status, 'pending');
});

test('l\'échec d\'un webhook ne bloque pas le traitement des autres (indépendants)', async () => {
  const db = buildMockDb();
  const fetchFn = buildFakeFetch([new Error('fail'), { ok: true, status: 200 }]);
  const dispatcher = createWebhookDispatcher({ db, webhookSigner: createWebhookSigner({ crypto }), fetchFn, logger: { warn() {}, error() {} } });

  await dispatcher.enqueue('b1', 'message.received', { text: 'a' });
  await dispatcher.enqueue('b1', 'session.connected', { text: 'b' });
  const config = buildConnectionConfig({ b1: { webhookUrl: 'https://example.com/hook', secret: 's' } });

  const result = await dispatcher.processQueue(config);

  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
});

test('computeBackoffDelay est plafonné à maxDelayMs', () => {
  const dispatcher = createWebhookDispatcher(
    { db: buildMockDb(), webhookSigner: createWebhookSigner({ crypto }), fetchFn: async () => ({ ok: true }), logger: { warn() {}, error() {} } },
    { baseDelayMs: 1000, maxDelayMs: 5000 },
  );

  assert.equal(dispatcher.computeBackoffDelay(0), 1000);
  assert.equal(dispatcher.computeBackoffDelay(10), 5000); // plafonné
});
