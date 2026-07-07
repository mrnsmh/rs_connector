'use strict';

/**
 * Adaptateur de canal Email (SMTP envoi + IMAP réception) — Task 7.
 *
 * Interface commune : { channelType, capabilities, createAdapter(deps, authDir, options) }.
 * L'objet retourné expose { connect, disconnect, isConnected, getState, sendMessage }.
 *
 * Spécificités Email :
 *   - Auth par compte SMTP (envoi) et IMAP (réception) → capabilities.auth = 'smtp_imap'.
 *   - Envoi via un « mailer » (SMTP) ; réception par POLLING IMAP des messages non lus.
 *   - Pas d'accusés de livraison/lecture normalisés → statusReceipts = false.
 *
 * Testabilité : les clients SMTP/IMAP sont INJECTÉS via des fabriques (deps.createMailer,
 * deps.createMailReceiver) au contrat simple, exactement comme fetchFn pour Telegram. Les
 * tests fournissent des mocks ; la vraie glue nodemailer/imapflow vit dans
 * adapters/email-transports.js (chargée uniquement en production).
 *
 * Contrats attendus des fabriques injectées :
 *   createMailer(smtpConfig)    -> { verify(): Promise, sendMail({from,to,subject,text}): Promise<{messageId}> }
 *   createMailReceiver(imapCfg) -> { connect(): Promise, fetchUnseen(): Promise<Array<{messageId,from,subject,text}>>, close(): Promise }
 */

const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_SUBJECT = 'Message';

const channelType = 'email';

const capabilities = {
  auth: 'smtp_imap',
  inbound: true,
  outbound: true,
  statusReceipts: false,
};

/**
 * @param {object} deps - { createMailer, createMailReceiver, logger }.
 * @param {string} authDir - Non utilisé (pas d'état sur disque) ; signature commune.
 * @param {object} [options] - { connectionId, credentials:{smtp,imap,from}, callbacks,
 *   pollIntervalMs, autoPoll, defaultSubject }.
 */
function createAdapter(deps, authDir, options = {}) {
  const { createMailer, createMailReceiver, logger } = deps || {};
  const creds = options.credentials || {};
  const smtpConfig = creds.smtp || null;
  const imapConfig = creds.imap || null;
  const fromAddress = creds.from || (smtpConfig && (smtpConfig.from || smtpConfig.user)) || null;
  const connectionId = options.connectionId;
  const onConnectionStateChange = options.onConnectionStateChange || null;
  const onIncomingMessage = options.onIncomingMessage || null;
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const autoPoll = options.autoPoll !== false;
  const defaultSubject = options.defaultSubject || DEFAULT_SUBJECT;

  let status = 'initializing';
  let mailer = null;
  let receiver = null;
  let pollTimer = null;
  let polling = false;

  function isConnected() {
    return status === 'connected';
  }

  function getState() {
    return { connected: isConnected(), status, channelType, from: fromAddress };
  }

  function notifyState() {
    if (!onConnectionStateChange) return;
    try {
      const r = onConnectionStateChange(getState());
      if (r && typeof r.catch === 'function') {
        r.catch((e) => logger && logger.error && logger.error({ err: e.message }, 'onConnectionStateChange (email) a échoué'));
      }
    } catch (e) {
      if (logger && logger.error) logger.error({ err: e.message }, 'onConnectionStateChange (email) a échoué (sync)');
    }
  }

  /**
   * Un tour de polling IMAP : récupère les messages non lus et remonte chacun via
   * onIncomingMessage. Retourne le nombre de messages traités.
   */
  async function pollOnce() {
    if (!receiver) return 0;
    const messages = await receiver.fetchUnseen();
    for (const m of messages || []) {
      if (!onIncomingMessage) continue;
      const payload = {
        from: m.from || null,
        messageId: m.messageId != null ? String(m.messageId) : null,
        text: m.text || null,
        subject: m.subject || null,
      };
      try {
        const r = onIncomingMessage(payload);
        if (r && typeof r.catch === 'function') {
          r.catch((e) => logger && logger.error && logger.error({ err: e.message }, 'onIncomingMessage (email) a échoué'));
        }
      } catch (e) {
        if (logger && logger.error) logger.error({ err: e.message }, 'onIncomingMessage (email) a échoué (sync)');
      }
    }
    return messages ? messages.length : 0;
  }

  function scheduleNextPoll() {
    if (polling) return;
    polling = true;
    const loop = async () => {
      if (!polling) return;
      try {
        await pollOnce();
      } catch (err) {
        if (logger && logger.warn) logger.warn({ connectionId, err: err.message }, 'Polling IMAP échoué');
      }
      if (polling) pollTimer = setTimeout(loop, pollIntervalMs);
    };
    pollTimer = setTimeout(loop, pollIntervalMs);
  }

  async function connect() {
    if (!smtpConfig) {
      status = 'error';
      if (logger && logger.error) logger.error({ connectionId }, 'Connexion Email impossible : configuration SMTP manquante');
      notifyState();
      return;
    }
    try {
      mailer = createMailer(smtpConfig);
      await mailer.verify();

      // Réception optionnelle : une connexion peut être configurée en envoi seul.
      if (imapConfig && createMailReceiver) {
        receiver = createMailReceiver(imapConfig);
        await receiver.connect();
        if (autoPoll) scheduleNextPoll();
      }

      status = 'connected';
      if (logger && logger.info) logger.info({ connectionId, from: fromAddress, inbound: !!receiver }, 'Connexion Email établie');
      notifyState();
    } catch (err) {
      status = 'error';
      if (logger && logger.error) logger.error({ connectionId, err: err.message }, 'Échec de connexion Email');
      notifyState();
    }
  }

  async function disconnect() {
    polling = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (receiver && receiver.close) {
      try { await receiver.close(); } catch { /* best effort */ }
    }
    status = 'disconnected';
    notifyState();
  }

  /**
   * Envoie un email texte. `to` = adresse destinataire, `text` = corps. Le sujet vient de
   * defaultSubject (configurable). Retourne { to, messageId }.
   */
  async function sendMessage(to, text) {
    if (!mailer) throw new Error('Email non connecté (transport SMTP indisponible)');
    const info = await mailer.sendMail({ from: fromAddress, to, subject: defaultSubject, text });
    return {
      to: String(to),
      messageId: info && info.messageId != null ? String(info.messageId) : null,
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
