'use strict';

/**
 * Connection Manager : une connexion (adaptateur de canal) indépendante par
 * connection_id. Généralise l'ancien session-manager (spécifique WhatsApp) — le canal
 * de chaque connexion est déterminé par son `channel_type`, résolu dans le registre
 * d'adaptateurs (voir adapters/index.js). Chaque connexion a son propre sous-dossier
 * d'auth, isolé des autres.
 *
 * Résolution de l'adaptateur :
 *   - si `deps.adapterRegistry` est fourni (cas production), la fabrique est résolue par
 *     channel_type via le registre ;
 *   - sinon, si une fabrique unique est fournie (`deps.createAdapter` ou `deps.createSession`),
 *     elle sert de fabrique par défaut — ce qui permet aux tests d'injecter directement un
 *     adaptateur mocké sans passer par le registre.
 */

const DEFAULT_CHANNEL_TYPE = 'whatsapp_baileys';

function createConnectionManager(deps, options = {}) {
  const { baseAuthDir, joinPath } = deps;
  const connections = new Map(); // connection_id -> { adapter, channelType }
  // Index de référence de canal ("channelType:ref" -> connection_id) pour router un
  // événement entrant push (ex. webhook Meta par phone_number_id) vers sa connexion.
  const channelRefIndex = new Map();

  const adapterRegistry = deps.adapterRegistry || null;
  const defaultFactory = deps.createAdapter || deps.createSession || null;

  // Callbacks globaux, invoqués pour CHAQUE connexion avec connectionId injecté
  // automatiquement — évite de dupliquer le câblage à chaque appel de getOrCreate().
  const { onConnectionStateChange, onMessageStatusUpdate, onIncomingMessage } = options;

  function authDirFor(connectionId) {
    return joinPath(baseAuthDir, String(connectionId));
  }

  function resolveFactory(channelType) {
    if (adapterRegistry) {
      const adapter = adapterRegistry.getAdapter(channelType);
      if (!adapter) {
        throw new Error(`Aucun adaptateur enregistré pour le canal "${channelType}"`);
      }
      return adapter.createAdapter;
    }
    if (defaultFactory) return defaultFactory;
    throw new Error("Aucun registre d'adaptateurs ni fabrique par défaut fourni au connection-manager");
  }

  /**
   * Crée (si absente) et retourne l'adaptateur de connexion. Idempotent : rappeler pour
   * le même connection_id retourne l'adaptateur existant sans le recréer.
   *
   * @param {string} connectionId
   * @param {object} [connOptions] - Options passées à l'adaptateur. `channelType` choisit
   *   le canal (défaut : whatsapp_baileys, pour la rétrocompatibilité avec le socle).
   */
  async function getOrCreate(connectionId, connOptions = {}) {
    if (!connectionId) throw new Error('connection_id requis');
    if (connections.has(connectionId)) return connections.get(connectionId).adapter;

    const channelType = connOptions.channelType || DEFAULT_CHANNEL_TYPE;
    const factory = resolveFactory(channelType);

    const mergedOptions = {
      ...connOptions,
      // connectionId transmis à l'adaptateur (ex. scoping du cache contacts côté WhatsApp).
      connectionId,
      onConnectionStateChange: onConnectionStateChange
        ? (state) => onConnectionStateChange(connectionId, state)
        : connOptions.onConnectionStateChange,
      onMessageStatusUpdate: onMessageStatusUpdate
        ? (payload) => onMessageStatusUpdate(connectionId, payload)
        : connOptions.onMessageStatusUpdate,
      onIncomingMessage: onIncomingMessage
        ? (payload) => onIncomingMessage(connectionId, payload)
        : connOptions.onIncomingMessage,
    };

    const channelDeps = (deps.channelDepsByType && deps.channelDepsByType[channelType]) || deps.sessionDeps;
    const adapter = factory(channelDeps, authDirFor(connectionId), mergedOptions);
    connections.set(connectionId, { adapter, channelType });
    if (adapter && adapter.channelRef != null) {
      channelRefIndex.set(`${channelType}:${adapter.channelRef}`, connectionId);
    }
    return adapter;
  }

  function get(connectionId) {
    const entry = connections.get(connectionId);
    return entry ? entry.adapter : null;
  }

  function list() {
    return Array.from(connections.keys());
  }

  /**
   * Retire une connexion de la map (ex. après logout définitif). Ne ferme pas le socket
   * lui-même — c'est la responsabilité de l'adaptateur.
   */
  function remove(connectionId) {
    for (const [key, id] of channelRefIndex.entries()) {
      if (id === connectionId) channelRefIndex.delete(key);
    }
    return connections.delete(connectionId);
  }

  /** Retrouve l'adaptateur d'une connexion par sa référence de canal (ex. phone_number_id). */
  function findByChannelRef(channelType, ref) {
    const connectionId = channelRefIndex.get(`${channelType}:${ref}`);
    if (!connectionId) return null;
    const entry = connections.get(connectionId);
    return entry ? entry.adapter : null;
  }

  function getAllStates() {
    const states = {};
    for (const [connectionId, entry] of connections.entries()) {
      states[connectionId] = entry.adapter.getState();
    }
    return states;
  }

  /** Retourne le channel_type d'une connexion active, ou null. */
  function channelTypeOf(connectionId) {
    const entry = connections.get(connectionId);
    return entry ? entry.channelType : null;
  }

  return { getOrCreate, get, list, remove, getAllStates, authDirFor, channelTypeOf, findByChannelRef };
}

module.exports = { createConnectionManager, DEFAULT_CHANNEL_TYPE };
