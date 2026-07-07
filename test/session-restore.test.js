'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Teste la restauration des connections au démarrage en important le VRAI module
 * (src/session-restore.js, désormais utilisé tel quel par index.js) — plus aucune
 * copie de la logique recopiée dans le fichier de test, pour que ces tests détectent
 * réellement une régression du code de production.
 */
const { restoreKnownSessions, RESTORABLE_STATUSES } = require('../src/session-restore');

function buildMockLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function buildMockSessionManager() {
  const connected = [];
  return {
    connected,
    async getOrCreate(connectionId) {
      return {
        async connect() { connected.push(connectionId); },
      };
    },
  };
}

test('les statuts restaurables incluent connected/qr_required/connecting/disconnected mais PAS logged_out/possibly_banned', () => {
  assert.deepEqual(RESTORABLE_STATUSES, ['connected', 'qr_required', 'connecting', 'disconnected']);
  assert.equal(RESTORABLE_STATUSES.includes('logged_out'), false);
  assert.equal(RESTORABLE_STATUSES.includes('possibly_banned'), false);
});

test('les connections avec statut connected/qr_required/connecting/disconnected sont restaurées', async () => {
  const db = {
    async listConnections() {
      return [
        { connection_id: 'b1', status: 'connected' },
        { connection_id: 'b2', status: 'qr_required' },
        { connection_id: 'b3', status: 'connecting' },
        { connection_id: 'b4', status: 'disconnected' },
      ];
    },
  };
  const sessionManager = buildMockSessionManager();

  await restoreKnownSessions(db, sessionManager, buildMockLogger());

  assert.deepEqual(sessionManager.connected.sort(), ['b1', 'b2', 'b3', 'b4']);
});

test("CORRECTIF : les connections logged_out ou possibly_banned ne sont JAMAIS restaurées automatiquement (action humaine requise)", async () => {
  const db = {
    async listConnections() {
      return [
        { connection_id: 'b1', status: 'logged_out' },
        { connection_id: 'b2', status: 'possibly_banned' },
        { connection_id: 'b3', status: 'connected' },
      ];
    },
  };
  const sessionManager = buildMockSessionManager();

  await restoreKnownSessions(db, sessionManager, buildMockLogger());

  assert.deepEqual(sessionManager.connected, ['b3']);
});

test('aucune session à restaurer -> aucun appel à getOrCreate', async () => {
  const db = { async listConnections() { return []; } };
  const sessionManager = buildMockSessionManager();

  await restoreKnownSessions(db, sessionManager, buildMockLogger());

  assert.deepEqual(sessionManager.connected, []);
});

test("un échec de restauration d'UNE connexion n'empêche pas la restauration des autres", async () => {
  const db = {
    async listConnections() {
      return [
        { connection_id: 'b1', status: 'connected' },
        { connection_id: 'b2', status: 'connected' },
      ];
    },
  };
  const sessionManager = {
    connected: [],
    async getOrCreate(connectionId) {
      if (connectionId === 'b1') {
        return { async connect() { throw new Error('Connexion Baileys échouée'); } };
      }
      return { connect: async () => { sessionManager.connected.push(connectionId); } };
    },
  };

  await assert.doesNotReject(() => restoreKnownSessions(db, sessionManager, buildMockLogger()));
  assert.deepEqual(sessionManager.connected, ['b2']);
});

test('un échec de db.listConnections() ne fait pas planter le démarrage (juste loggé)', async () => {
  const db = { async listConnections() { throw new Error('DB indisponible au démarrage'); } };
  const sessionManager = buildMockSessionManager();

  await assert.doesNotReject(() => restoreKnownSessions(db, sessionManager, buildMockLogger()));
  assert.deepEqual(sessionManager.connected, []);
});
