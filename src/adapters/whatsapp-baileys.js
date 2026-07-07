'use strict';

/**
 * Adaptateur de canal WhatsApp (Baileys) — premier adaptateur de rs-connector.
 *
 * Il enveloppe `src/session.js` (l'implémentation Baileys existante, non modifiée) pour
 * l'exposer via l'interface commune d'adaptateur attendue par le connection-manager :
 *
 *   { channelType, capabilities, createAdapter(deps, authDir, options) }
 *
 * `createAdapter` a exactement la même signature que `createSession` et retourne le même
 * objet { connect, isConnected, getState, sendMessage, ... }. Aucun comportement WhatsApp
 * n'est changé ici : ce module est uniquement la « prise » qui branche Baileys dans
 * l'abstraction multi-canal (voir adapters/index.js).
 */

const { createSession } = require('../session');

// Identifiant de canal, tel que stocké dans connections.channel_type.
const channelType = 'whatsapp_baileys';

// Capacités déclarées de ce canal (utile au back-office et au routage : ce canal
// s'authentifie par QR, gère l'entrant/sortant et remonte des accusés de statut).
const capabilities = {
  auth: 'qr',
  inbound: true,
  outbound: true,
  statusReceipts: true,
};

/**
 * @param {object} deps - Dépendances Baileys injectées (makeWASocket, useMultiFileAuthState,
 *   fetchLatestBaileysVersion, DisconnectReason, fs, logger, db...). Identiques à session.js.
 * @param {string} authDir - Répertoire d'auth dédié à cette connexion.
 * @param {object} [options] - Callbacks (onConnectionStateChange/onIncomingMessage/
 *   onMessageStatusUpdate) et options (connectionId, autoReconnect...).
 */
function createAdapter(deps, authDir, options = {}) {
  return createSession(deps, authDir, options);
}

module.exports = { channelType, capabilities, createAdapter };
