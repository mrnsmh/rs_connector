'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../src/db');

/**
 * Mock minimal du pool `pg` : simule une table en mémoire suffisante pour exercer
 * upsertConnection / getConnection / listConnections / deleteConnection / recordMessageStatus /
 * getMessageStatusHistory sans dépendre d'une vraie base Postgres en test unitaire.
 */
function buildMockPool() {
  const connections = new Map(); // connection_id -> row
  const messagesStatus = []; // liste de rows
  const contacts = new Map(); // "connectionId:lid" -> row
  const anomalies = []; // liste de rows
  const outboxWebhooks = new Map(); // id -> row
  let nextOutboxId = 1;

  const pool = {
    async query(sql, params = []) {
      const normalized = sql.trim().replace(/\s+/g, ' ');

      if (normalized.startsWith('INSERT INTO connections')) {
        const [connectionId, phoneNumber, status, qrCode, webhookUrl] = params;
        const existing = connections.get(connectionId);
        const row = {
          connection_id: connectionId,
          phone_number: phoneNumber ?? existing?.phone_number ?? null,
          status,
          qr_code: qrCode,
          webhook_url: webhookUrl ?? existing?.webhook_url ?? null,
          last_connected_at: status === 'connected' ? new Date().toISOString() : existing?.last_connected_at ?? null,
          updated_at: new Date().toISOString(),
          created_at: existing?.created_at ?? new Date().toISOString(),
        };
        connections.set(connectionId, row);
        return { rows: [row] };
      }

      if (normalized.startsWith('SELECT * FROM connections WHERE connection_id')) {
        const [connectionId] = params;
        const row = connections.get(connectionId);
        return { rows: row ? [row] : [] };
      }

      if (normalized.startsWith('SELECT * FROM connections ORDER BY')) {
        return { rows: Array.from(connections.values()) };
      }

      if (normalized.startsWith('DELETE FROM connections')) {
        const [connectionId] = params;
        connections.delete(connectionId);
        return { rows: [] };
      }

      if (normalized.startsWith('INSERT INTO messages_status')) {
        const [connectionId, messageId, status] = params;
        const row = {
          id: messagesStatus.length + 1,
          connection_id: connectionId,
          message_id: messageId,
          status,
          occurred_at: new Date().toISOString(),
        };
        messagesStatus.push(row);
        return { rows: [row] };
      }

      if (normalized.startsWith('SELECT * FROM messages_status WHERE message_id')) {
        const [messageId] = params;
        return { rows: messagesStatus.filter((r) => r.message_id === messageId) };
      }

      if (normalized.startsWith('INSERT INTO contacts')) {
        const [connectionId, lid, phoneNumber] = params;
        const row = { connection_id: connectionId, lid, phone_number: phoneNumber, resolved_at: new Date().toISOString() };
        contacts.set(`${connectionId}:${lid}`, row);
        return { rows: [row] };
      }

      if (normalized.startsWith('SELECT * FROM contacts WHERE connection_id')) {
        const [connectionId, lid] = params;
        const row = contacts.get(`${connectionId}:${lid}`);
        return { rows: row ? [row] : [] };
      }

      if (normalized.startsWith('INSERT INTO message_status_anomalies')) {
        const [connectionId, messageId, fromStatus, attemptedStatus, reason] = params;
        const row = {
          id: anomalies.length + 1,
          connection_id: connectionId,
          message_id: messageId,
          from_status: fromStatus,
          attempted_status: attemptedStatus,
          reason,
          occurred_at: new Date().toISOString(),
        };
        anomalies.push(row);
        return { rows: [row] };
      }

      if (normalized.startsWith('SELECT * FROM message_status_anomalies WHERE message_id')) {
        const [messageId] = params;
        return { rows: anomalies.filter((r) => r.message_id === messageId) };
      }

      if (normalized.startsWith('SELECT * FROM message_status_anomalies ORDER BY')) {
        const [limit] = params;
        return { rows: anomalies.slice().reverse().slice(0, limit) };
      }

      if (normalized.startsWith('INSERT INTO outbox_webhooks')) {
        const [connectionId, eventType, payload] = params;
        const id = nextOutboxId++;
        const row = {
          id,
          connection_id: connectionId,
          event_type: eventType,
          payload: JSON.parse(payload),
          status: 'pending',
          attempts: 0,
          next_retry_at: new Date().toISOString(),
          last_error: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        outboxWebhooks.set(id, row);
        return { rows: [row] };
      }

      if (normalized.startsWith('SELECT * FROM outbox_webhooks WHERE status')) {
        const [limit] = params;
        const nowMs = Date.now();
        const rows = Array.from(outboxWebhooks.values())
          .filter((r) => r.status === 'pending' && new Date(r.next_retry_at).getTime() <= nowMs)
          .sort((a, b) => new Date(a.next_retry_at) - new Date(b.next_retry_at))
          .slice(0, limit);
        return { rows };
      }

      if (normalized.startsWith("UPDATE outbox_webhooks SET status = 'sent'")) {
        const [id] = params;
        const row = outboxWebhooks.get(id);
        if (row) { row.status = 'sent'; row.updated_at = new Date().toISOString(); }
        return { rows: row ? [row] : [] };
      }

      if (normalized.startsWith('UPDATE outbox_webhooks SET status = $2')) {
        const [id, status, nextRetryAt, reason] = params;
        const row = outboxWebhooks.get(id);
        if (row) {
          row.status = status;
          row.attempts += 1;
          row.next_retry_at = nextRetryAt;
          row.last_error = reason;
          row.updated_at = new Date().toISOString();
        }
        return { rows: row ? [row] : [] };
      }

      if (normalized.startsWith('SELECT * FROM outbox_webhooks WHERE id')) {
        const [id] = params;
        const row = outboxWebhooks.get(id);
        return { rows: row ? [row] : [] };
      }

      if (normalized.startsWith('SELECT * FROM outbox_webhooks WHERE connection_id')) {
        const [connectionId, limit] = params;
        const rows = Array.from(outboxWebhooks.values())
          .filter((r) => r.connection_id === connectionId)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .slice(0, limit);
        return { rows };
      }

      throw new Error(`Requête non gérée par le mock : ${normalized}`);
    },
    async end() {},
  };

  return pool;
}

test('upsertConnection crée puis met à jour une session (UPSERT)', async () => {
  const db = createDb(buildMockPool());

  const created = await db.upsertConnection({ connectionId: 'b1', status: 'qr_required', qrCode: 'ABC' });
  assert.equal(created.connection_id, 'b1');
  assert.equal(created.status, 'qr_required');

  const updated = await db.upsertConnection({ connectionId: 'b1', status: 'connected', phoneNumber: '212600000000' });
  assert.equal(updated.status, 'connected');
  assert.equal(updated.phone_number, '212600000000');
});

test('getConnection retourne null pour une connexion inconnue', async () => {
  const db = createDb(buildMockPool());
  const result = await db.getConnection('inconnue');
  assert.equal(result, null);
});

test('listConnections retourne toutes les connections créées', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });
  await db.upsertConnection({ connectionId: 'b2', status: 'qr_required' });

  const all = await db.listConnections();
  assert.equal(all.length, 2);
});

test('deleteConnection retire bien la session', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });
  await db.deleteConnection('b1');

  const result = await db.getConnection('b1');
  assert.equal(result, null);
});

test('recordMessageStatus + getMessageStatusHistory suivent les transitions dans l\'ordre', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });

  await db.recordMessageStatus({ connectionId: 'b1', messageId: 'm1', status: 'sent' });
  await db.recordMessageStatus({ connectionId: 'b1', messageId: 'm1', status: 'delivered' });

  const history = await db.getMessageStatusHistory('m1');
  assert.equal(history.length, 2);
  assert.equal(history[0].status, 'sent');
  assert.equal(history[1].status, 'delivered');
});

// Correctif post-relecture critique : cache LID (table contacts).
test('upsertContact puis getContact retourne le mapping mis en cache', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });

  await db.upsertContact({ connectionId: 'b1', lid: '139642322083882', phoneNumber: '212604258663' });
  const contact = await db.getContact('b1', '139642322083882');

  assert.equal(contact.phone_number, '212604258663');
});

test('getContact retourne null si le mapping est inconnu', async () => {
  const db = createDb(buildMockPool());
  const contact = await db.getContact('b1', 'inconnu');
  assert.equal(contact, null);
});

test('upsertContact met à jour le mapping existant (pas de doublon)', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });

  await db.upsertContact({ connectionId: 'b1', lid: '139642322083882', phoneNumber: '212604258663' });
  await db.upsertContact({ connectionId: 'b1', lid: '139642322083882', phoneNumber: '212699999999' });

  const contact = await db.getContact('b1', '139642322083882');
  assert.equal(contact.phone_number, '212699999999');
});

// Correctif post-relecture critique : anomalies de transition persistées (plus de simple log).
test('recordStatusAnomaly + getStatusAnomalies retrouvent les transitions rejetées d\'un message', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });

  await db.recordStatusAnomaly({
    connectionId: 'b1',
    messageId: 'm1',
    fromStatus: 'read',
    attemptedStatus: 'sent',
    reason: 'Transition invalide : "read" -> "sent"',
  });

  const anomalies = await db.getStatusAnomalies('m1');
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].from_status, 'read');
  assert.equal(anomalies[0].attempted_status, 'sent');
});

test('listRecentStatusAnomalies retourne les anomalies les plus récentes toutes connexions', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });
  await db.upsertConnection({ connectionId: 'b2', status: 'connected' });

  await db.recordStatusAnomaly({ connectionId: 'b1', messageId: 'm1', fromStatus: 'read', attemptedStatus: 'sent', reason: 'x' });
  await db.recordStatusAnomaly({ connectionId: 'b2', messageId: 'm2', fromStatus: 'delivered', attemptedStatus: 'sent', reason: 'y' });

  const recent = await db.listRecentStatusAnomalies(10);
  assert.equal(recent.length, 2);
});

// Task 6 : outbox persistante des webhooks sortants.
test('enqueueWebhook crée une entrée en statut pending', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });

  const webhook = await db.enqueueWebhook({ connectionId: 'b1', eventType: 'message.received', payload: { from: '212600000000' } });

  assert.equal(webhook.status, 'pending');
  assert.equal(webhook.event_type, 'message.received');
  assert.deepEqual(webhook.payload, { from: '212600000000' });
});

test('getPendingWebhooks ne retourne que les entrées pending dont l\'échéance est passée', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });
  await db.enqueueWebhook({ connectionId: 'b1', eventType: 'message.received', payload: {} });

  const pending = await db.getPendingWebhooks(10);
  assert.equal(pending.length, 1);
});

test('markWebhookSent passe le statut à sent', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });
  const webhook = await db.enqueueWebhook({ connectionId: 'b1', eventType: 'message.received', payload: {} });

  await db.markWebhookSent(webhook.id);
  const pending = await db.getPendingWebhooks(10);

  assert.equal(pending.length, 0);
});

test('markWebhookFailed incrémente attempts et replanifie next_retry_at', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });
  const webhook = await db.enqueueWebhook({ connectionId: 'b1', eventType: 'message.received', payload: {} });

  const future = new Date(Date.now() + 60_000);
  const updated = await db.markWebhookFailed(webhook.id, { reason: 'Timeout', nextRetryAt: future, permanent: false });

  assert.equal(updated.attempts, 1);
  assert.equal(updated.status, 'pending');
  assert.equal(updated.last_error, 'Timeout');
});

test('markWebhookFailed avec permanent=true bascule en failed_permanent (exclu de getPendingWebhooks)', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });
  const webhook = await db.enqueueWebhook({ connectionId: 'b1', eventType: 'message.received', payload: {} });

  await db.markWebhookFailed(webhook.id, { reason: 'Erreur définitive', nextRetryAt: null, permanent: true });
  const pending = await db.getPendingWebhooks(10);

  assert.equal(pending.length, 0);
  const stored = await db.getWebhook(webhook.id);
  assert.equal(stored.status, 'failed_permanent');
});

test('listWebhooksByConnection retourne l\'historique complet d\'une connexion', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected' });
  await db.enqueueWebhook({ connectionId: 'b1', eventType: 'message.received', payload: {} });
  await db.enqueueWebhook({ connectionId: 'b1', eventType: 'session.connected', payload: {} });

  const history = await db.listWebhooksByConnection('b1', 10);
  assert.equal(history.length, 2);
});

test('upsertConnection accepte et persiste webhookUrl', async () => {
  const db = createDb(buildMockPool());
  await db.upsertConnection({ connectionId: 'b1', status: 'connected', webhookUrl: 'https://example.com/webhook' });

  const session = await db.getConnection('b1');
  assert.equal(session.webhook_url, 'https://example.com/webhook');
});
