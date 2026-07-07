'use strict';

/**
 * Module de connexion Baileys pour une session unique (Task 2 : 1 connexion).
 * Copié et adapté (CommonJS, pas ES modules) du pattern validé côté deskassit
 * (/root/deskassit/baileys-bridge/src/connection.js) — aucune dépendance de code partagée.
 *
 * Écart volontaire vs deskassit : la factory Baileys (`makeWASocket`) et les helpers d'auth
 * sont injectés en paramètre plutôt qu'importés en dur, pour permettre les tests avec un
 * Baileys entièrement mocké (aucun socket réel ouvert pendant les tests).
 *
 * Point complémentaire ajouté (absent côté deskassit, identifié en AUDIT.md) : un compteur de
 * tentatives de reconnexion consécutives fait basculer le statut vers `possibly_banned` au-delà
 * d'un seuil, au lieu de reconnecter indéfiniment en silence.
 */

const MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_POSSIBLY_BANNED_THRESHOLD = 8;
const { fromBaileysStatusCode } = require('./message-status');
const { createContactResolver } = require('./contact-resolver');

/**
 * Crée une session Baileys pour une connexion donnée.
 *
 * @param {object} deps - Dépendances injectables (permet le mock en test).
 * @param {Function} deps.makeWASocket - Factory Baileys (ou mock).
 * @param {Function} deps.useMultiFileAuthState - Helper d'auth Baileys (ou mock).
 * @param {Function} deps.fetchLatestBaileysVersion - Helper de version Baileys (ou mock).
 * @param {Function} [deps.makeCacheableSignalKeyStore] - Helper de cache de clés (ou mock).
 * @param {object} deps.DisconnectReason - Enum Baileys des raisons de déconnexion.
 * @param {object} deps.fs - fs/promises (ou mock), pour clearAuthDir et le contact resolver.
 * @param {object} deps.logger - Logger pino (ou mock).
 * @param {object} [deps.db] - Instance db.js (ou mock), pour le cache LID (Task 5, correctif).
 * @param {string} authDir - Répertoire d'auth dédié à cette session.
 * @param {object} [options]
 * @param {number} [options.possiblyBannedThreshold] - Seuil de tentatives avant `possibly_banned`.
 * @param {string} [options.connectionId] - Identifiant connexion, transmis au contact resolver
 *   pour le cache DB (Task 5, correctif) — sans lui, seule la lecture fichier est utilisée.
 */
function createSession(deps, authDir, options = {}) {
  const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fs,
    logger,
    db,
  } = deps;

  const possiblyBannedThreshold = options.possiblyBannedThreshold || DEFAULT_POSSIBLY_BANNED_THRESHOLD;
  // Désactivable en test (autoReconnect: false) pour éviter des setTimeout réels qui
  // retardent la suite de tests sans affecter le résultat des assertions.
  const autoReconnect = options.autoReconnect !== false;
  // Callback optionnel invoqué à CHAQUE transition de connexion (Task 4 : permet de
  // persister en DB toutes les transitions, pas seulement l'état à la création —
  // limite identifiée en Task 3). Signature : (state) => void|Promise<void>.
  const onConnectionStateChange = options.onConnectionStateChange || null;
  // Callback optionnel invoqué pour chaque accusé de statut de message reçu via
  // messages.update. Signature : ({ messageId, status }) => void|Promise<void>.
  const onMessageStatusUpdate = options.onMessageStatusUpdate || null;
  // Task 6 : callback optionnel invoqué pour chaque message WhatsApp entrant, permettant
  // d'enqueue un événement webhook ("message.received") vers l'application propriétaire.
  // Signature : ({ from, messageId, text }) => void|Promise<void>.
  const onIncomingMessage = options.onIncomingMessage || null;

  let sock = null;
  let reconnectAttempts = 0;
  let connectionStatus = 'initializing';
  let lastQr = null;
  let lastQrGeneratedAt = null;
  let lastDisconnectReason = null;
  let reconnectTimer = null;
  let connectingPromise = null;
  let connectionGeneration = 0;

  // Task 5 : résolution LID→numéro réel, isolée et testée (voir contact-resolver.js).
  // Correctif post-relecture critique : db + connectionId transmis pour activer le cache
  // persistant du mapping LID (table contacts), et pour que resolve() lève une erreur
  // explicite (LidUnresolvedError) plutôt qu'un repli silencieux si le mapping manque.
  const contactResolver = createContactResolver({ fs, db }, authDir, options.connectionId);

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function closeSocket() {
    if (!sock) return;
    try {
      sock.ev.removeAllListeners();
      sock.ws?.close?.();
    } catch (err) {
      logger.warn({ err: err.message }, 'Échec de fermeture du socket existant');
    }
    sock = null;
  }

  /**
   * Vide le CONTENU du dossier d'auth (mountpoint-safe — voir explication dans le pattern
   * deskassit original : le dossier lui-même est un point de montage Docker, on ne le
   * supprime jamais, seulement son contenu).
   */
  async function clearAuthDir() {
    await fs.readdir(authDir)
      .then((files) => Promise.all(
        files.map((f) => fs.rm(`${authDir}/${f}`, { recursive: true, force: true })),
      ))
      .catch(() => {});
  }

  function isConnected() {
    return connectionStatus === 'connected';
  }

  function getState() {
    const connected = isConnected();
    return {
      connected,
      status: connected ? 'connected' : connectionStatus,
      qr: lastQr,
      qrGeneratedAt: lastQrGeneratedAt,
      lastDisconnectReason,
      reconnectAttempts,
      authDir,
    };
  }

  /**
   * Envoie un message texte WhatsApp sortant, en résolvant d'abord le destinataire
   * (LID→numéro réel) via le contact resolver (Task 5). Lève une erreur explicite si
   * la session n'est pas connectée, plutôt que d'échouer silencieusement.
   *
   * @param {string} to - Numéro, JID ou LID du destinataire.
   * @param {string} text - Texte du message.
   * @returns {Promise<{jid: string, messageId: string|null}>}
   */
  async function sendMessage(to, text) {
    if (!sock || !isConnected()) {
      throw new Error('Session WhatsApp non connectée');
    }
    const jid = await contactResolver.resolve(to);
    logger.info({ to, jid }, 'Envoi WhatsApp sortant');
    const result = await sock.sendMessage(jid, { text });
    return { jid, messageId: result?.key?.id || null };
  }

  /**
   * Notifie le callback externe (s'il existe) à chaque changement d'état de connexion,
   * pour permettre la persistance de TOUTES les transitions (pas seulement la création).
   */
  function notifyConnectionStateChange() {
    if (!onConnectionStateChange) return;
    try {
      const result = onConnectionStateChange(getState());
      if (result && typeof result.catch === 'function') {
        result.catch((err) => logger.error({ err: err.message }, 'onConnectionStateChange a échoué'));
      }
    } catch (err) {
      logger.error({ err: err.message }, 'onConnectionStateChange a échoué (synchrone)');
    }
  }

  function scheduleReconnect(delay) {
    if (!autoReconnect) return;
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((err) => logger.error({ err: err.message }, 'Reconnexion échouée'));
    }, delay);
  }

  async function connect() {
    if (connectingPromise) return connectingPromise;
    if (isConnected()) return sock;

    clearReconnectTimer();
    const generation = ++connectionGeneration;
    logger.info({ authDir }, 'Initialisation de la connexion WhatsApp');
    connectionStatus = 'connecting';

    connectingPromise = (async () => {
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version, isLatest } = await fetchLatestBaileysVersion();

      if (generation !== connectionGeneration) return sock;

      logger.info({ version: Array.isArray(version) ? version.join('.') : version, isLatest }, 'Version Baileys');

      closeSocket();

      const authKeys = makeCacheableSignalKeyStore
        ? makeCacheableSignalKeyStore(state.keys, logger)
        : state.keys;

      const currentSock = makeWASocket({
        version,
        auth: { creds: state.creds, keys: authKeys },
        logger,
        browser: ['desklink', 'Chrome', '120.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: async () => ({ conversation: '' }),
      });
      sock = currentSock;

      currentSock.ev.on('creds.update', saveCreds);

      currentSock.ev.on('connection.update', async (update) => {
        if (generation !== connectionGeneration || currentSock !== sock) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          lastQr = qr;
          lastQrGeneratedAt = new Date().toISOString();
          connectionStatus = 'qr_required';
          logger.info('QR code généré (disponible via API)');
          notifyConnectionStateChange();
        }

        if (connection === 'open') {
          reconnectAttempts = 0;
          connectionStatus = 'connected';
          lastQr = null;
          lastQrGeneratedAt = null;
          lastDisconnectReason = null;
          logger.info('WhatsApp connecté avec succès');
          notifyConnectionStateChange();
        }

        if (connection === 'close') {
          if (generation !== connectionGeneration || currentSock !== sock) return;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          lastDisconnectReason = statusCode || lastDisconnect?.error?.message;

          logger.warn({ statusCode, isLoggedOut }, 'Connexion WhatsApp fermée');

          if (isLoggedOut) {
            connectionStatus = 'logged_out';
            logger.error({ authDir }, 'Déconnecté (logout). Nettoyage des identifiants...');
            await clearAuthDir();
            lastQr = null;
            lastQrGeneratedAt = null;
            reconnectAttempts = 0;
            notifyConnectionStateChange();
            scheduleReconnect(2000);
            return;
          }

          // Point complémentaire (AUDIT.md) : au-delà du seuil de tentatives consécutives,
          // on distingue explicitement un possible bannissement plutôt que de reconnecter
          // indéfiniment en silence. IMPORTANT : cela ne vaut que pour un compte DÉJÀ appairé
          // (state.creds.registered). Avant l'appairage (attente de scan QR), les fermetures
          // — timeout 408 pendant l'attente, redémarrage 515 juste après le scan — sont
          // normales et ne doivent PAS être qualifiées de bannissement (faux positif).
          reconnectAttempts++;
          const isRegistered = !!(state && state.creds && state.creds.registered);
          if (isRegistered && reconnectAttempts >= possiblyBannedThreshold) {
            connectionStatus = 'possibly_banned';
            logger.error(
              { authDir, reconnectAttempts, statusCode },
              `Bannissement possible : ${reconnectAttempts} tentatives de reconnexion consécutives échouées`,
            );
          } else if (!isRegistered) {
            // Appairage non finalisé : on reste en attente de QR (ou en connexion), sans alarme.
            connectionStatus = lastQr ? 'qr_required' : 'connecting';
          } else {
            connectionStatus = 'disconnected';
          }
          notifyConnectionStateChange();

          const delay = Math.min(1_000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);
          logger.info({ attempt: reconnectAttempts, delayMs: delay, status: connectionStatus }, 'Reconnexion planifiée');
          scheduleReconnect(delay);
        }
      });

      currentSock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (generation !== connectionGeneration || currentSock !== sock) return;
        if (type !== 'notify') return;
        // Task 2 : traitement des messages entrants hors périmètre (voir Task 9 pour le
        // branchement métier). On se limite ici à logguer la réception.
        for (const msg of messages || []) {
          const remoteJid = msg.key?.remoteJid;
          logger.info({ from: remoteJid }, 'Message WhatsApp reçu');

          // Correctif post-relecture critique : un message entrant peut révéler la
          // correspondance LID->numéro réel de l'expéditeur (Baileys expose parfois le
          // numéro réel via `msg.key.participant` ou `msg.key.remoteJidAlt` en plus du
          // LID de `remoteJid`). Quand c'est le cas, on alimente le cache DB tout de
          // suite, sans attendre un éventuel envoi sortant vers ce contact.
          if (remoteJid?.endsWith('@lid')) {
            const lidDigits = remoteJid.replace(/[^0-9]/g, '');
            const altJid = msg.key?.remoteJidAlt || msg.key?.participantAlt;
            const phoneDigits = altJid ? String(altJid).replace(/[^0-9]/g, '') : null;
            if (lidDigits && phoneDigits && /^[0-9]{6,}$/.test(phoneDigits)) {
              contactResolver.learnMapping(lidDigits, phoneDigits).catch((err) => {
                logger.warn({ err: err.message, lidDigits }, "Échec d'apprentissage du mapping LID depuis un message entrant");
              });
            }
          }

          // Task 6 : notifie l'application propriétaire d'un message entrant via webhook
          // (enqueue dans l'outbox DB, jamais un envoi HTTP direct depuis ce listener).
          if (onIncomingMessage) {
            const text = msg.message?.conversation
              || msg.message?.extendedTextMessage?.text
              || null;
            try {
              const result = onIncomingMessage({ from: remoteJid, messageId: msg.key?.id || null, text });
              if (result && typeof result.catch === 'function') {
                result.catch((err) => logger.error({ err: err.message }, 'onIncomingMessage a échoué'));
              }
            } catch (err) {
              logger.error({ err: err.message }, 'onIncomingMessage a échoué (synchrone)');
            }
          }
        }
      });

      // Task 4 : accusés de livraison/lecture. Absent côté deskassit (P0 de l'AUDIT.md) —
      // le bridge actuel n'écoute jamais cet événement, donc "envoyé" ≠ "livré" ≠ "lu".
      currentSock.ev.on('messages.update', async (updates) => {
        if (generation !== connectionGeneration || currentSock !== sock) return;
        if (!onMessageStatusUpdate) return;

        for (const update of updates || []) {
          const messageId = update?.key?.id;
          const rawStatus = update?.update?.status;
          if (!messageId || rawStatus === undefined) continue;

          const status = fromBaileysStatusCode(rawStatus);
          if (!status) continue; // code non pertinent pour la state machine (ex. PENDING)

          try {
            const result = onMessageStatusUpdate({ messageId, status, rawStatus });
            if (result && typeof result.catch === 'function') {
              await result.catch((err) => logger.error({ err: err.message, messageId }, 'onMessageStatusUpdate a échoué'));
            }
          } catch (err) {
            logger.error({ err: err.message, messageId }, 'onMessageStatusUpdate a échoué (synchrone)');
          }
        }
      });

      return currentSock;
    })().finally(() => {
      connectingPromise = null;
    });

    return connectingPromise;
  }

  return {
    connect,
    isConnected,
    getState,
    sendMessage,
    _internal: { clearAuthDir, contactResolver }, // exposé uniquement pour les tests
  };
}

module.exports = { createSession, MAX_RECONNECT_DELAY_MS, DEFAULT_POSSIBLY_BANNED_THRESHOLD };
