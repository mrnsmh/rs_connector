'use strict';

/**
 * Point d'assemblage entre connection-manager.js (testable en isolation) et les vraies
 * dépendances de canal (Baileys pour WhatsApp), via le registre d'adaptateurs.
 *
 * Câble aussi la persistance DB de TOUTES les transitions de connexion et des accusés de
 * statut de message, via la state machine (message-status.js) qui rejette les transitions
 * invalides avant toute écriture ; et le dispatcher de webhooks sortants (enqueue
 * uniquement — jamais d'envoi HTTP direct depuis ce fichier) sur trois événements :
 * message entrant, changement de statut de message, connexion/déconnexion.
 *
 * Les trois builders de handlers (buildConnectionStateHandler, buildMessageStatusHandler,
 * buildIncomingMessageHandler) sont exportés pour être testés en important le VRAI code
 * (voir connection-manager-factory-logic.test.js).
 */

const fs = require('fs/promises');
const path = require('path');
const baileys = require('@whiskeysockets/baileys');
const adapterRegistry = require('./adapters');
const emailTransports = require('./adapters/email-transports');
const { createConnectionManager } = require('./connection-manager');
const { transition } = require('./message-status');
const logger = require('./logger');

// Statuts de connexion qui déclenchent un webhook "session.connected"/"session.disconnected".
// Les transitions purement internes (ex. qr_required, connecting) ne sont pas notifiées —
// seuls les changements d'état significatifs pour l'application propriétaire.
const CONNECTED_STATUS = 'connected';
const DISCONNECTED_STATUSES = ['logged_out', 'possibly_banned'];

/**
 * Construit le handler de transition de connexion (persistance DB + webhooks).
 * Retourne `undefined` si aucune DB n'est fournie (rien à persister).
 *
 * @param {object} deps
 * @param {object} [deps.db]
 * @param {object} [deps.webhookDispatcher]
 * @param {Map<string,string>} deps.lastConnectionStatusByConnection - Suivi en mémoire du
 *   dernier statut connu par connexion, pour ne notifier un webhook qu'au moment de la
 *   transition réelle (pas à chaque callback, qui peut répéter le même état).
 */
function buildConnectionStateHandler({ db, webhookDispatcher, lastConnectionStatusByConnection }) {
  if (!db) return undefined;
  return async (connectionId, state) => {
    await db.upsertConnection({ connectionId, status: state.status, qrCode: state.qr });

    if (!webhookDispatcher) return;
    const previousStatus = lastConnectionStatusByConnection.get(connectionId) || null;
    if (state.status === previousStatus) return; // pas de transition réelle
    lastConnectionStatusByConnection.set(connectionId, state.status);

    if (state.status === CONNECTED_STATUS) {
      await webhookDispatcher.enqueue(connectionId, 'session.connected', { connectionId, status: state.status });
    } else if (DISCONNECTED_STATUSES.includes(state.status) && previousStatus === CONNECTED_STATUS) {
      await webhookDispatcher.enqueue(connectionId, 'session.disconnected', { connectionId, status: state.status });
    }
  };
}

/**
 * Construit le handler d'accusé de statut de message : applique la state machine
 * (message-status.js), persiste la transition valide, et persiste une anomalie
 * consultable en cas de transition invalide (sans jamais interrompre le flux du canal).
 * Retourne `undefined` si aucune DB n'est fournie.
 *
 * @param {object} deps
 * @param {object} [deps.db]
 * @param {object} [deps.webhookDispatcher]
 * @param {object} [deps.logger] - Logger (défaut : logger pino du module).
 * @param {Map<string,string>} deps.lastStatusByMessage - Suivi en mémoire du dernier
 *   statut connu par message_id (transition() a besoin du statut courant).
 */
function buildMessageStatusHandler({ db, webhookDispatcher, lastStatusByMessage, logger: log = logger }) {
  if (!db) return undefined;
  return async (connectionId, { messageId, status }) => {
    const current = lastStatusByMessage.get(messageId) || null;
    try {
      const next = transition(current, status);
      lastStatusByMessage.set(messageId, next);
      await db.recordMessageStatus({ connectionId, messageId, status: next });

      if (webhookDispatcher) {
        await webhookDispatcher.enqueue(connectionId, 'message.status_changed', { connectionId, messageId, status: next });
      }
    } catch (err) {
      // Une transition invalide (doublon d'accusé, événement hors-ordre réseau, ou statut
      // réellement contradictoire renvoyé par le canal) n'est pas seulement logguée — elle
      // est persistée dans un état consultable, pour qu'un message resté bloqué en "sent"
      // alors qu'il a en réalité été rejeté puisse être diagnostiqué. Le flux n'est jamais
      // interrompu.
      log.warn({ err: err.message, connectionId, messageId, status }, 'Transition de statut invalide — anomalie persistée');
      try {
        await db.recordStatusAnomaly({
          connectionId,
          messageId,
          fromStatus: current,
          attemptedStatus: status,
          reason: err.message,
        });
      } catch (anomalyErr) {
        log.error({ err: anomalyErr.message, connectionId, messageId }, "Échec de persistance de l'anomalie de statut");
      }
    }
  };
}

/**
 * Construit le handler de message entrant : enqueue un webhook "message.received" dans
 * l'outbox DB (jamais un envoi HTTP direct). Retourne `undefined` si aucun dispatcher
 * n'est fourni.
 *
 * @param {object} deps
 * @param {object} [deps.webhookDispatcher]
 */
function buildIncomingMessageHandler({ webhookDispatcher }) {
  if (!webhookDispatcher) return undefined;
  return async (connectionId, { from, messageId, text }) => {
    await webhookDispatcher.enqueue(connectionId, 'message.received', { connectionId, from, messageId, text });
  };
}

/**
 * Assemble un connection-manager de production : registre d'adaptateurs + dépendances
 * Baileys + câblage DB/webhooks.
 *
 * @param {string} baseAuthDir
 * @param {object} [db] - Instance db.js, optionnelle. Si fournie, chaque transition de
 *   connexion et chaque accusé de statut sont persistés, et le cache LID (table contacts)
 *   est activé pour l'adaptateur WhatsApp.
 * @param {object} [webhookDispatcher] - Instance webhook-dispatcher.js, optionnelle.
 * @param {Map<string,string>} [lastStatusByMessage]
 * @param {Map<string,string>} [lastConnectionStatusByConnection]
 */
function createRealConnectionManager(
  baseAuthDir,
  db,
  webhookDispatcher,
  lastStatusByMessage = new Map(),
  lastConnectionStatusByConnection = new Map(),
) {
  // Dépendances de canal injectées aux adaptateurs. Aujourd'hui centrées sur Baileys
  // (WhatsApp) ; quand un canal aux dépendances différentes sera ajouté (Telegram, Email),
  // ce bloc évoluera vers une résolution de dépendances par channel_type.
  const sessionDeps = {
    makeWASocket: baileys.default || baileys.makeWASocket,
    useMultiFileAuthState: baileys.useMultiFileAuthState,
    fetchLatestBaileysVersion: baileys.fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore: baileys.makeCacheableSignalKeyStore,
    DisconnectReason: baileys.DisconnectReason,
    fs,
    logger,
    db, // nécessaire pour le cache LID du contact resolver (adaptateur WhatsApp).
  };

  // Dépendances par canal pour les adaptateurs non-WhatsApp. Telegram parle à l'API Bot
  // via HTTP (fetch natif de Node 20+). WhatsApp continue d'utiliser sessionDeps (fallback).
  const channelDepsByType = {
    telegram: { fetchFn: fetch, logger },
    whatsapp_cloud: { fetchFn: fetch, logger },
    email: {
      createMailer: emailTransports.createMailer,
      createMailReceiver: emailTransports.createMailReceiver,
      logger,
    },
  };

  return createConnectionManager(
    {
      adapterRegistry,
      baseAuthDir,
      joinPath: path.join,
      sessionDeps,
      channelDepsByType,
    },
    {
      onConnectionStateChange: buildConnectionStateHandler({ db, webhookDispatcher, lastConnectionStatusByConnection }),
      onMessageStatusUpdate: buildMessageStatusHandler({ db, webhookDispatcher, lastStatusByMessage }),
      onIncomingMessage: buildIncomingMessageHandler({ webhookDispatcher }),
    },
  );
}

module.exports = {
  createRealConnectionManager,
  buildConnectionStateHandler,
  buildMessageStatusHandler,
  buildIncomingMessageHandler,
  CONNECTED_STATUS,
  DISCONNECTED_STATUSES,
};
