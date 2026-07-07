'use strict';

/**
 * Registre des adaptateurs de canal, indexé par `channel_type`.
 *
 * Le connection-manager y résout la fabrique d'adaptateur (`createAdapter`) correspondant
 * au `channel_type` d'une connexion. Ajouter un nouveau canal à rs-connector = créer son module
 * d'adaptateur (interface { channelType, capabilities, createAdapter }) puis l'enregistrer
 * ici — sans toucher au cœur (connection-manager, db, webhooks).
 */

const whatsappBaileys = require('./whatsapp-baileys');
const telegram = require('./telegram');
const email = require('./email');
const whatsappCloud = require('./whatsapp-cloud');

const adapters = new Map();

/**
 * Enregistre un adaptateur. Valide qu'il expose bien le contrat minimal.
 * @param {{channelType: string, createAdapter: Function, capabilities?: object}} adapter
 */
function register(adapter) {
  if (!adapter || typeof adapter.channelType !== 'string' || typeof adapter.createAdapter !== 'function') {
    throw new Error('Adaptateur invalide : { channelType: string, createAdapter: function } requis');
  }
  adapters.set(adapter.channelType, adapter);
}

// Canaux enregistrés : WhatsApp (Baileys + Cloud API Meta), Telegram, Email.
register(whatsappBaileys);
register(telegram);
register(email);
register(whatsappCloud);

/**
 * Retourne l'adaptateur enregistré pour un channel_type, ou null s'il n'existe pas.
 * @param {string} channelType
 */
function getAdapter(channelType) {
  return adapters.get(channelType) || null;
}

/** Liste des channel_type disponibles (pour le back-office / diagnostics). */
function listChannelTypes() {
  return Array.from(adapters.keys());
}

// Canal par défaut quand aucun n'est précisé (rétrocompatibilité avec le socle WhatsApp).
const DEFAULT_CHANNEL_TYPE = whatsappBaileys.channelType;

module.exports = { register, getAdapter, listChannelTypes, DEFAULT_CHANNEL_TYPE };
