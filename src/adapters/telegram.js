'use strict';

/**
 * Adaptateur de canal Telegram (Bot API) — premier NOUVEAU canal de rs-connector, il valide
 * l'abstraction d'adaptateur au-delà de WhatsApp.
 *
 * Interface commune (identique à l'adaptateur WhatsApp) :
 *   { channelType, capabilities, createAdapter(deps, authDir, options) }
 * et l'objet retourné expose { connect, disconnect, isConnected, getState, sendMessage }.
 *
 * Spécificités Telegram :
 *   - Auth par TOKEN de bot (pas de QR) : le bot est « connecté » dès que getMe réussit.
 *   - Entrant par LONG POLLING (getUpdates) : aucune URL publique requise, contrairement
 *     au mode webhook. L'offset est avancé après chaque lot pour ne pas retraiter.
 *   - Pas d'accusés de livraison/lecture côté bot → capabilities.statusReceipts = false.
 *
 * Dépendances injectées (deps) : { fetchFn, logger }. fetchFn est une fonction fetch-like,
 * injectée pour rester testable sans réseau réel (mock).
 */

const DEFAULT_POLL_INTERVAL_MS = 1000;

const channelType = 'telegram';

const capabilities = {
  auth: 'token',
  inbound: true,
  outbound: true,
  statusReceipts: false,
};

/**
 * @param {object} deps - { fetchFn, logger }.
 * @param {string} authDir - Non utilisé par Telegram (pas d'état d'auth sur disque) ;
 *   présent pour respecter la signature commune des adaptateurs.
 * @param {object} [options] - { connectionId, token | credentials:{token}, callbacks,
 *   pollIntervalMs, autoPoll }.
 */
function createAdapter(deps, authDir, options = {}) {
  const { fetchFn, logger } = deps || {};
  const token = (options.credentials && options.credentials.token) || options.token || null;
  const connectionId = options.connectionId;
  const onConnectionStateChange = options.onConnectionStateChange || null;
  const onIncomingMessage = options.onIncomingMessage || null;
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const autoPoll = options.autoPoll !== false;

  let status = 'initializing';
  let botInfo = null;
  let updateOffset = 0;
  let pollTimer = null;
  let polling = false;

  function isConnected() {
    return status === 'connected';
  }

  function getState() {
    return {
      connected: isConnected(),
      status,
      channelType,
      username: botInfo ? botInfo.username : null,
    };
  }

  function notifyState() {
    if (!onConnectionStateChange) return;
    try {
      const r = onConnectionStateChange(getState());
      if (r && typeof r.catch === 'function') {
        r.catch((e) => logger && logger.error && logger.error({ err: e.message }, 'onConnectionStateChange (telegram) a échoué'));
      }
    } catch (e) {
      if (logger && logger.error) logger.error({ err: e.message }, 'onConnectionStateChange (telegram) a échoué (sync)');
    }
  }

  async function callApi(method, body) {
    if (!token) throw new Error('Token Telegram manquant');
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!data || !data.ok) {
      throw new Error(`Telegram API ${method} a échoué : ${(data && data.description) || 'réponse non ok'}`);
    }
    return data.result;
  }

  /**
   * Un tour de polling : récupère les updates en attente, avance l'offset, et remonte
   * chaque message entrant via onIncomingMessage. Retourne le nombre d'updates traités.
   */
  async function pollOnce() {
    const updates = await callApi('getUpdates', { offset: updateOffset, timeout: 0 });
    for (const update of updates || []) {
      if (typeof update.update_id === 'number' && update.update_id >= updateOffset) {
        updateOffset = update.update_id + 1;
      }
      const msg = update.message;
      if (!msg) continue;
      if (!onIncomingMessage) continue;
      const payload = {
        from: msg.chat && msg.chat.id != null ? String(msg.chat.id) : null,
        messageId: msg.message_id != null ? String(msg.message_id) : null,
        text: msg.text || null,
      };
      try {
        const r = onIncomingMessage(payload);
        if (r && typeof r.catch === 'function') {
          r.catch((e) => logger && logger.error && logger.error({ err: e.message }, 'onIncomingMessage (telegram) a échoué'));
        }
      } catch (e) {
        if (logger && logger.error) logger.error({ err: e.message }, 'onIncomingMessage (telegram) a échoué (sync)');
      }
    }
    return updates ? updates.length : 0;
  }

  function scheduleNextPoll() {
    if (polling) return;
    polling = true;
    const loop = async () => {
      if (!polling) return;
      try {
        await pollOnce();
      } catch (err) {
        if (logger && logger.warn) logger.warn({ connectionId, err: err.message }, 'Polling Telegram échoué');
      }
      if (polling) pollTimer = setTimeout(loop, pollIntervalMs);
    };
    pollTimer = setTimeout(loop, pollIntervalMs);
  }

  async function connect() {
    if (!token) {
      status = 'error';
      if (logger && logger.error) logger.error({ connectionId }, 'Connexion Telegram impossible : token manquant');
      notifyState();
      return;
    }
    try {
      botInfo = await callApi('getMe');
      status = 'connected';
      if (logger && logger.info) logger.info({ connectionId, username: botInfo && botInfo.username }, 'Bot Telegram connecté');
      notifyState();
      if (autoPoll) scheduleNextPoll();
    } catch (err) {
      status = 'error';
      if (logger && logger.error) logger.error({ connectionId, err: err.message }, 'Échec de connexion Telegram (getMe)');
      notifyState();
    }
  }

  function disconnect() {
    polling = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    status = 'disconnected';
    notifyState();
  }

  /**
   * Envoie un message texte. `to` est le chat_id Telegram. Retourne { to, messageId }.
   */
  async function sendMessage(to, text) {
    const result = await callApi('sendMessage', { chat_id: to, text });
    return {
      to: String(to),
      messageId: result && result.message_id != null ? String(result.message_id) : null,
    };
  }

  return {
    connect,
    disconnect,
    isConnected,
    getState,
    sendMessage,
    _internal: { pollOnce }, // exposé uniquement pour les tests
  };
}

module.exports = { channelType, capabilities, createAdapter, DEFAULT_POLL_INTERVAL_MS };
