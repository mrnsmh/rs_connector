'use strict';

/**
 * Adaptateur de canal WhatsApp renforcé (`whatsapp_whtsp`) — branché sur le moteur
 * anti-ban `@whtsp/core` (rate-limiter, warm-up, graphe de contacts, frappe WPM gaussien,
 * légitimité, déconnexions typées 463/429/401, télémétrie de risque).
 *
 * Interface commune (identique à `whatsapp-baileys.js`) :
 *   { channelType, capabilities, createAdapter(deps, authDir, options) }
 * et l'objet retourné expose { connect, disconnect, isConnected, getState, sendMessage }
 * avec EXACTEMENT la même forme de getState() que src/session.js (contrat consommé par
 * Django via GET /v1/connections) + un accès `antiBan` pour le health endpoint.
 *
 * Dépendances injectées (deps, voir connection-manager-factory.js) :
 *   { fs (fs/promises), logger, db } — db sert au cache LID du contact resolver.
 *
 * Charge `@whtsp/core` via src/whtsp-loader.js (pont ESM↔CJS) — jamais de require direct.
 */

const { dirname, basename } = require('node:path');
const { loadWhtsp } = require('../whtsp-loader');
const { fromBaileysStatusCode } = require('../message-status');
const { createContactResolver } = require('../contact-resolver');

const channelType = 'whatsapp_whtsp';

const capabilities = {
  auth: 'qr',
  pairingCode: true, // appairage alternatif par numéro (WhatsApp → « Lier avec le numéro »)
  inbound: true,
  outbound: true,
  statusReceipts: true,
  antiBan: true, // ce canal embarque le moteur 0-ban (télémétrie de risque disponible)
};

/**
 * @param {object} deps - { fs, logger, db }.
 * @param {string} authDir - Répertoire d'auth dédié à cette connexion.
 * @param {object} [options] - { connectionId, browser, antibanConfig, callbacks,
 *   onConnectionStateChange, onMessageStatusUpdate, onIncomingMessage }.
 */
function createAdapter(deps, authDir, options = {}) {
  const { fs, logger, db } = deps || {};
  const log = logger || { info() {}, warn() {}, error() {} };
  const connectionId = options.connectionId;
  const onConnectionStateChange = options.onConnectionStateChange || null;
  const onMessageStatusUpdate = options.onMessageStatusUpdate || null;
  const onIncomingMessage = options.onIncomingMessage || null;

  // Résolution LID→numéro réel (même contrat que session.js) : cache DB + fichier.
  const contactResolver = createContactResolver({ fs, db }, authDir, connectionId);

  let client = null;
  let clientPromise = null;
  let status = 'initializing';
  let lastQr = null;
  let lastQrGeneratedAt = null;
  let lastDisconnectReason = null;
  let reconnectAttempts = 0;
  let pairingCode = null;
  let pairingCodeAt = null;
  let destroyed = false;

  function isConnected() {
    return status === 'connected';
  }

  function getState() {
    const connected = isConnected();
    return {
      connected,
      status: connected ? 'connected' : status,
      qr: lastQr,
      qrGeneratedAt: lastQrGeneratedAt,
      pairingCode,
      pairingCodeAt,
      lastDisconnectReason,
      reconnectAttempts,
      authDir,
      channelType,
    };
  }

  function notifyState() {
    if (!onConnectionStateChange) return;
    try {
      const result = onConnectionStateChange(getState());
      if (result && typeof result.catch === 'function') {
        result.catch((err) => log.error({ err: err.message }, 'onConnectionStateChange a échoué'));
      }
    } catch (err) {
      log.error({ err: err.message }, 'onConnectionStateChange a échoué (synchrone)');
    }
  }

  function safeCall(fn) {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') {
        result.catch((err) => log.error({ err: err.message }, 'Callback adaptateur whatsapp_whtsp a échoué'));
      }
    } catch (err) {
      log.error({ err: err.message }, 'Callback adaptateur whatsapp_whtsp a échoué (synchrone)');
    }
  }

  function wireEvents(c) {
    c.on('connection.update', (update) => {
      if (destroyed) return;
      const { connection, lastDisconnect, qr } = update || {};

      if (qr) {
        lastQr = qr;
        lastQrGeneratedAt = new Date().toISOString();
        status = 'qr_required';
        log.info({ connectionId }, 'QR code généré (whatsapp_whtsp)');
        notifyState();
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
        status = 'connected';
        lastQr = null;
        lastQrGeneratedAt = null;
        pairingCode = null;
        pairingCodeAt = null;
        lastDisconnectReason = null;
        log.info({ connectionId }, 'WhatsApp connecté (whatsapp_whtsp)');
        notifyState();
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        lastDisconnectReason = statusCode || lastDisconnect?.error?.message || null;
        const fatal = statusCode === 401 || statusCode === 440; // logged out / logged out by server
        log.warn({ connectionId, statusCode }, 'Connexion WhatsApp fermée (whatsapp_whtsp)');
        if (fatal) {
          status = 'logged_out';
          // @whtsp/core ne reconnecte jamais sur les déconnexions fatales : on nettoie l'auth.
          clearAuthDir().catch(() => {});
        } else {
          status = 'disconnected';
          reconnectAttempts += 1;
        }
        notifyState();
      }
    });

    c.on('messages.upsert', ({ messages, type }) => {
      if (destroyed || type !== 'notify') return;
      for (const msg of messages || []) {
        const remoteJid = msg.key?.remoteJid;

        // Apprentissage LID→numéro réel depuis un message entrant (miroir de session.js).
        if (remoteJid?.endsWith('@lid')) {
          const lidDigits = remoteJid.replace(/[^0-9]/g, '');
          const altJid = msg.key?.remoteJidAlt || msg.key?.participantAlt;
          const phoneDigits = altJid ? String(altJid).replace(/[^0-9]/g, '') : null;
          if (lidDigits && phoneDigits && /^[0-9]{6,}$/.test(phoneDigits)) {
            contactResolver.learnMapping(lidDigits, phoneDigits).catch((err) => {
              log.warn({ err: err.message, lidDigits }, "Échec d'apprentissage du mapping LID (whatsapp_whtsp)");
            });
          }
        }

        if (onIncomingMessage) {
          const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || null;
          safeCall(() => onIncomingMessage({ from: remoteJid, messageId: msg.key?.id || null, text }));
        }
      }
    });

    c.on('messages.update', (updates) => {
      if (destroyed || !onMessageStatusUpdate) return;
      for (const update of updates || []) {
        const messageId = update?.key?.id;
        const rawStatus = update?.update?.status;
        if (!messageId || rawStatus === undefined) continue;
        const next = fromBaileysStatusCode(rawStatus);
        if (!next) continue; // code non pertinent pour la state machine (ex. PENDING)
        safeCall(() => onMessageStatusUpdate({ messageId, status: next, rawStatus }));
      }
    });
  }

  /** Vide le CONTENU du dossier d'auth (jamais le dossier lui-même : mountpoint Docker). */
  async function clearAuthDir() {
    if (!fs) return;
    await fs.readdir(authDir)
      .then((files) => Promise.all(
        files.map((f) => fs.rm(`${authDir}/${f}`, { recursive: true, force: true })),
      ))
      .catch(() => {});
  }

  async function ensureClient() {
    if (client) return client;
    if (clientPromise) return clientPromise;
    clientPromise = (async () => {
      const whtsp = await loadWhtsp();
      const c = await whtsp.createWhtspClient({
        // authDir reçu = <base>/<connectionId> → reconstitution via dirname/basename.
        config: {
          authDir: dirname(authDir),
          sessionId: basename(authDir),
          ...(options.antibanConfig || {}),
        },
        antibanConfig: { ...(options.antibanConfig || {}) },
        browser: options.browser,
      });
      wireEvents(c);
      client = c;
      status = 'connecting';
      notifyState();
      return c;
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
    return clientPromise;
  }

  async function connect() {
    await ensureClient();
  }

  async function disconnect() {
    destroyed = true;
    if (client && typeof client.disconnect === 'function') {
      try {
        await client.disconnect();
      } catch (err) {
        log.warn({ err: err.message }, 'disconnect whatsapp_whtsp (best effort)');
      }
    }
    client = null;
    status = 'disconnected';
    notifyState();
  }

  /**
   * Envoie un message texte WhatsApp sortant. Résout d'abord le destinataire (LID→numéro
   * réel) via le contact resolver, puis passe par le moteur anti-ban de @whtsp/core
   * (beforeSend → délai + frappe réaliste → envoi → afterSend). Retourne { jid, messageId }.
   */
  async function sendMessage(to, text) {
    const c = await ensureClient();
    const jid = await contactResolver.resolve(to);
    log.info({ to, jid, connectionId }, 'Envoi WhatsApp sortant (whatsapp_whtsp)');
    const result = await c.sendText(jid, text);
    return { jid, messageId: result?.key?.id || null };
  }

  /**
   * Demande un code d'appairage à 8 caractères (alternative au scan QR) via le socket
   * Baileys brut exposé par @whtsp/core (`client.socket`). Même contrat que session.js.
   *
   * @param {string} phoneNumber - Numéro international, chiffres uniquement (ex. "212612345678").
   * @returns {Promise<string>} Le code à 8 caractères (ex. "ABCD-1234").
   */
  async function requestPairingCode(phoneNumber) {
    const digits = String(phoneNumber || '').replace(/[^0-9]/g, '');
    if (!/^\d{8,15}$/.test(digits)) {
      const err = new Error("Numéro invalide : format international sans « + » ni espaces (ex. 212612345678)");
      err.statusCode = 400;
      throw err;
    }
    if (destroyed) {
      const err = new Error('Connexion détruite.');
      err.statusCode = 503;
      throw err;
    }
    const c = await ensureClient();
    const sk = c.socket;
    if (!sk || typeof sk.requestPairingCode !== 'function') {
      const err = new Error('Appairage par code indisponible sur ce client.');
      err.statusCode = 501;
      throw err;
    }
    if (isConnected()) {
      const err = new Error('Session déjà appairée — déconnectez-la avant de re-appairer.');
      err.statusCode = 409;
      throw err;
    }
    const code = await sk.requestPairingCode(digits);
    pairingCode = code;
    pairingCodeAt = new Date().toISOString();
    status = 'pairing_code_sent';
    notifyState();
    log.info({ connectionId }, "Code d'appairage généré (whatsapp_whtsp)");
    return code;
  }

  return {
    connect,
    disconnect,
    isConnected,
    getState,
    sendMessage,
    requestPairingCode,
    // Télémétrie anti-ban exposée pour GET /v1/connections/:id/health.
    antiBan: {
      getState: () => (client && client.antiBan ? client.antiBan.getState() : null),
      pause: (reason) => client && client.antiBan && client.antiBan.pause(reason),
      resume: () => client && client.antiBan && client.antiBan.resume(),
    },
    _internal: { clearAuthDir, contactResolver }, // exposé uniquement pour les tests
  };
}

module.exports = { channelType, capabilities, createAdapter };

