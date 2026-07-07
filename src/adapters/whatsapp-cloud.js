'use strict';

/**
 * Adaptateur de canal WhatsApp Cloud API (Meta) — Task 8, en complément de Baileys.
 *
 * Différence de modèle importante : contrairement à Baileys (socket), Telegram (polling) et
 * Email (polling IMAP), Meta **pousse** les messages entrants via un WEBHOOK. L'adaptateur
 * n'a donc pas de boucle de réception : c'est la route `POST /webhooks/whatsapp-cloud`
 * (voir app.js) qui, après vérification de signature, appelle `ingestWebhook(value)` sur
 * l'adaptateur de la connexion identifiée par `phone_number_id`.
 *
 * Auth : token d'accès Meta + phone_number_id (identifiant du numéro WhatsApp Business).
 * Envoi : POST Graph API /{phone_number_id}/messages. Statuts (sent/delivered/read/failed)
 * arrivent aussi par webhook → capabilities.statusReceipts = true.
 *
 * Dépendances injectées : { fetchFn, logger }.
 */

const DEFAULT_GRAPH_VERSION = 'v21.0';

const channelType = 'whatsapp_cloud';

const capabilities = {
  auth: 'token',
  inbound: true, // via webhook (push), pas de polling
  outbound: true,
  statusReceipts: true,
};

function createAdapter(deps, authDir, options = {}) {
  const { fetchFn, logger } = deps || {};
  const creds = options.credentials || {};
  const token = creds.token || options.token || null;
  const phoneNumberId = creds.phoneNumberId || options.phoneNumberId || null;
  const graphVersion = options.graphVersion || creds.graphVersion || DEFAULT_GRAPH_VERSION;
  const connectionId = options.connectionId;
  const onConnectionStateChange = options.onConnectionStateChange || null;
  const onIncomingMessage = options.onIncomingMessage || null;
  const onMessageStatusUpdate = options.onMessageStatusUpdate || null;

  let status = 'initializing';

  function isConnected() {
    return status === 'connected';
  }

  function getState() {
    return { connected: isConnected(), status, channelType, phoneNumberId };
  }

  function safeCall(fn, payload) {
    if (!fn) return;
    try {
      const r = fn(payload);
      if (r && typeof r.catch === 'function') {
        r.catch((e) => logger && logger.error && logger.error({ err: e.message }, 'callback (whatsapp_cloud) a échoué'));
      }
    } catch (e) {
      if (logger && logger.error) logger.error({ err: e.message }, 'callback (whatsapp_cloud) a échoué (sync)');
    }
  }

  function notifyState() {
    safeCall(onConnectionStateChange, getState());
  }

  async function graph(method, apiPath, body) {
    if (!token) throw new Error('Token WhatsApp Cloud manquant');
    const res = await fetchFn(`https://graph.facebook.com/${graphVersion}/${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await (res.json ? res.json().catch(() => null) : null);
    if (!res.ok) {
      const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
      throw new Error(`Graph API a échoué : ${msg}`);
    }
    return data;
  }

  async function connect() {
    if (!token || !phoneNumberId) {
      status = 'error';
      if (logger && logger.error) logger.error({ connectionId }, 'Connexion WhatsApp Cloud impossible : token ou phone_number_id manquant');
      notifyState();
      return;
    }
    try {
      await graph('GET', `${phoneNumberId}?fields=id`, null);
      status = 'connected';
      if (logger && logger.info) logger.info({ connectionId, phoneNumberId }, 'WhatsApp Cloud connecté');
      notifyState();
    } catch (err) {
      status = 'error';
      if (logger && logger.error) logger.error({ connectionId, err: err.message }, 'Échec de connexion WhatsApp Cloud');
      notifyState();
    }
  }

  function disconnect() {
    status = 'disconnected';
    notifyState();
  }

  async function sendMessage(to, text) {
    const data = await graph('POST', `${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: String(to),
      type: 'text',
      text: { body: text },
    });
    const messageId = data && Array.isArray(data.messages) && data.messages[0] ? data.messages[0].id : null;
    return { to: String(to), messageId };
  }

  /**
   * Traite un objet `value` d'un webhook Meta (entry[].changes[].value) : messages
   * entrants et accusés de statut. Appelé par la route webhook après vérification de
   * signature. Retourne le nombre d'éléments traités.
   */
  function ingestWebhook(value) {
    let messages = 0;
    let statuses = 0;
    if (value && Array.isArray(value.messages)) {
      for (const m of value.messages) {
        messages += 1;
        const text = m.text ? m.text.body : (m.button ? m.button.text : null);
        safeCall(onIncomingMessage, { from: m.from || null, messageId: m.id || null, text });
      }
    }
    if (value && Array.isArray(value.statuses)) {
      for (const s of value.statuses) {
        statuses += 1;
        safeCall(onMessageStatusUpdate, { messageId: s.id || null, status: s.status || null });
      }
    }
    return { messages, statuses };
  }

  return {
    connect,
    disconnect,
    isConnected,
    getState,
    sendMessage,
    ingestWebhook,
    // Référence de canal exploitée par le connection-manager pour router un webhook
    // entrant (par phone_number_id) vers la bonne connexion.
    channelRef: phoneNumberId,
  };
}

module.exports = { channelType, capabilities, createAdapter, DEFAULT_GRAPH_VERSION };
