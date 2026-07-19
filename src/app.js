'use strict';

const express = require('express');
const pinoHttp = require('pino-http');
const logger = require('./logger');
const { LidUnresolvedError } = require('./contact-resolver');
const { createApiKeyAuth } = require('./auth-apikey');
const { verifyMetaSignature, checkVerification, extractInboundEvents } = require('./whatsapp-cloud-webhook');
const { createAdminRouter } = require('./admin/routes');
const { createUserRouter } = require('./user/routes');
const { createRequireAdmin } = require('./admin/auth-admin');
const adapterRegistry = require('./adapters');
const path = require('node:path');

/**
 * Construit l'application Express (sans démarrer le listener HTTP).
 * Séparé de index.js pour permettre les tests avec supertest sans ouvrir de vrai port.
 *
 * @param {object} [options]
 * @param {object} [options.connectionManager] - Gestionnaire multi-session (Task 3).
 *   Doit exposer getOrCreate(connectionId), get(connectionId), list(), getAllStates().
 * @param {object} [options.db] - Accès DB (Task 3), optionnel selon les endpoints appelés.
 */
function createApp(options = {}) {
  const { connectionManager, db, rateLimiter, whatsappCloud, admin, vault, publicBaseUrl = '', workerToken = process.env.WORKER_TOKEN, systemMailer = null } = options;
  // Anti-abus : limite de requetes /v1/messages par application et par minute (0 = desactive).
  const v1RateLimitPerMin = options.v1RateLimitPerMin !== undefined
    ? options.v1RateLimitPerMin
    : (process.env.V1_RATE_LIMIT_PER_MIN !== undefined ? Number(process.env.V1_RATE_LIMIT_PER_MIN) : 240);
  const v1RateBuckets = new Map();
  const app = express();

  // Derrière un reverse-proxy (nginx + Cloudflare) : tenir compte des en-têtes X-Forwarded-*
  // (proto HTTPS, IP réelle du client) pour cookies Secure, logs et rate-limit.
  app.set('trust proxy', 1);

  app.use(pinoHttp({ logger }));
  // `verify` capture le corps BRUT pour la vérification de signature des webhooks (Meta).
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'rs-connector',
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // Sert le back-office (frontend construit) s'il est présent — déploiement conteneur : une
  // seule origine pour l'UI + l'API, donc le cookie de session fonctionne sans proxy.
  const publicDir = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // Back-office sécurisé (Task 9) : routes /admin (login → OTP → session, CSRF, lockout) +
  // provisioning (apps/connexions avec credentials chiffrés).
  app.use('/admin', createAdminRouter({ db, admin, vault, connectionManager, adapterRegistry, publicBaseUrl }));

  // Espace SELF-SERVICE utilisateur : routes /u (inscription/connexion/session + gestion de
  // SES applications et canaux, isolées par utilisateur). Cookie de session dédié (rsconnector_user).
  app.use('/u', createUserRouter({ db, vault, connectionManager, adapterRegistry, mailer: systemMailer, publicBaseUrl, user: { cookieSecure: !admin || admin.cookieSecure !== false } }));

  // Sécurité : les endpoints de diagnostic/gestion GLOBAUX ci-dessous (héritage Tasks 2–6)
  // étaient exposés SANS authentification alors que nginx route « / » vers ce service. Ils
  // sont désormais réservés à une session admin authentifiée (OTP vérifié + CSRF sur les
  // mutations), en réutilisant la MÊME garde que le back-office /admin. Les usages scopés
  // par utilisateur/application restent sur /u et /v1 (inchangés).
  const requireAdmin = createRequireAdmin(db);

  function requireConnectionManager(req, res) {
    if (!connectionManager) {
      res.status(503).json({ error: 'Gestionnaire de session non initialisé' });
      return false;
    }
    return true;
  }

  // Liste toutes les connections actives (toutes connexions) — utile pour un tableau de bord.
  app.get('/connections', requireAdmin, (req, res) => {
    if (!requireConnectionManager(req, res)) return;
    res.status(200).json({ connexions: connectionManager.list(), states: connectionManager.getAllStates() });
  });

  // Crée (si nécessaire) et retourne l'état/QR d'une session pour une connexion donnée.
  // C'est la route Task 3 remplaçant le /qr global de la Task 2 (1 seule connexion).
  // Task 4 : la persistance DB de CHAQUE transition est désormais gérée automatiquement
  // par le callback onConnectionStateChange (voir connection-manager-factory.js), plus
  // besoin de persister manuellement ici l'état au moment de la création.
  app.get('/connections/:connectionId/qr', requireAdmin, async (req, res) => {
    if (!requireConnectionManager(req, res)) return;
    try {
      const { connectionId } = req.params;
      const session = await connectionManager.getOrCreate(connectionId);
      await session.connect();
      res.status(200).json(session.getState());
    } catch (err) {
      logger.error({ err: err.message, connectionId: req.params.connectionId }, 'Erreur récupération QR');
      res.status(500).json({ error: 'Erreur interne' });
    }
  });

  app.get('/connections/:connectionId', requireAdmin, (req, res) => {
    if (!requireConnectionManager(req, res)) return;
    const session = connectionManager.get(req.params.connectionId);
    if (!session) return res.status(404).json({ error: 'Session inconnue pour cette connexion' });
    res.status(200).json(session.getState());
  });

  // Task 6 : configuration de l'URL webhook propre à une connexion (destinataire des
  // événements message.received / message.status_changed / session.connected/disconnected).
  // Si non configurée, le dispatcher retombe sur DEFAULT_WEBHOOK_URL (voir index.js).
  app.patch('/connections/:connectionId/webhook', requireAdmin, async (req, res) => {
    if (!db) {
      return res.status(503).json({ error: 'Base de données non initialisée' });
    }
    const { webhook_url: webhookUrl } = req.body || {};
    if (!webhookUrl || typeof webhookUrl !== 'string') {
      return res.status(400).json({ error: 'webhook_url (string) est requis' });
    }
    try {
      const existing = await db.getConnection(req.params.connectionId);
      if (!existing) {
        return res.status(404).json({ error: 'Session inconnue pour cette connexion' });
      }
      const updated = await db.upsertConnection({ connectionId: req.params.connectionId, status: existing.status, webhookUrl });
      res.status(200).json({ connectionId: updated.connection_id, webhookUrl: updated.webhook_url });
    } catch (err) {
      logger.error({ err: err.message, connectionId: req.params.connectionId }, 'Erreur configuration webhook');
      res.status(500).json({ error: 'Erreur interne' });
    }
  });

  // Task 6 : historique des événements webhook (outbox) d'une connexion — utile pour
  // diagnostiquer un webhook resté `pending` ou passé en `failed_permanent`.
  app.get('/connections/:connectionId/webhooks', requireAdmin, async (req, res) => {
    if (!db) {
      return res.status(503).json({ error: 'Base de données non initialisée' });
    }
    try {
      const limit = Number.parseInt(req.query.limit, 10) || 50;
      const webhooks = await db.listWebhooksByConnection(req.params.connectionId, limit);
      res.status(200).json({ connectionId: req.params.connectionId, webhooks });
    } catch (err) {
      logger.error({ err: err.message, connectionId: req.params.connectionId }, 'Erreur récupération des webhooks');
      res.status(500).json({ error: 'Erreur interne' });
    }
  });

  // Task 4 : historique complet des transitions de statut d'un message donné
  // (sent -> delivered -> read, ou sent -> failed -> retry -> sent...).
  // Correctif post-relecture critique : inclut aussi les transitions rejetées
  // (anomalies) pour ce message, auparavant uniquement disponibles dans les logs.
  app.get('/messages/:messageId/status-history', requireAdmin, async (req, res) => {
    if (!db) {
      return res.status(503).json({ error: 'Base de données non initialisée' });
    }
    try {
      const [history, anomalies] = await Promise.all([
        db.getMessageStatusHistory(req.params.messageId),
        db.getStatusAnomalies(req.params.messageId),
      ]);
      res.status(200).json({ messageId: req.params.messageId, history, anomalies });
    } catch (err) {
      logger.error({ err: err.message, messageId: req.params.messageId }, 'Erreur récupération historique statut');
      res.status(500).json({ error: 'Erreur interne' });
    }
  });

  // Correctif post-relecture critique : vue globale des anomalies de statut les plus
  // récentes (toutes connexions), pour diagnostiquer sans devoir chercher un message_id
  // précis — utile pour détecter un pattern (ex. un type de statut Baileys mal géré).
  app.get('/anomalies', requireAdmin, async (req, res) => {
    if (!db) {
      return res.status(503).json({ error: 'Base de données non initialisée' });
    }
    try {
      const limit = Number.parseInt(req.query.limit, 10) || 50;
      const anomalies = await db.listRecentStatusAnomalies(limit);
      res.status(200).json({ anomalies });
    } catch (err) {
      logger.error({ err: err.message }, 'Erreur récupération des anomalies');
      res.status(500).json({ error: 'Erreur interne' });
    }
  });

  // ==========================================================================
  // API d'entrée multi-app (/v1), authentifiée par clé API (Task 5).
  // Chaque application ne voit et n'agit que sur SES connexions (scoping strict).
  // ==========================================================================
  const apiKeyAuth = createApiKeyAuth(db);

  // Limiteur anti-abus par application (fenetre fixe de 60 s). Complementaire du rateLimiter
  // par connexion (debit d'envoi) : ici on plafonne le NOMBRE d'appels /v1 par cle/application,
  // pour contenir une boucle cliente ou une cle fuitee. req.application est pose par apiKeyAuth.
  function v1RateLimit(req, res, next) {
    if (!v1RateLimitPerMin || v1RateLimitPerMin <= 0) return next();
    const now = Date.now();
    const id = req.application.id;
    let bucket = v1RateBuckets.get(id);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60_000 };
      v1RateBuckets.set(id, bucket);
    }
    bucket.count += 1;
    if (bucket.count > v1RateLimitPerMin) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: 'rate_limited',
        message: `Limite de ${v1RateLimitPerMin} requetes/min par application atteinte`,
        retryAfterSeconds,
      });
    }
    return next();
  }

  // Envoi sortant. La connexion visée est sélectionnée par `channel` (type de canal). Si
  // l'application possède plusieurs connexions du même canal, `connection_id` lève l'ambiguïté.
  // Si l'application ne possède qu'une seule connexion, les deux sont facultatifs.
  // Scoping strict : on ne résout jamais une connexion hors de l'application appelante.
  app.post('/v1/messages', apiKeyAuth, v1RateLimit, async (req, res) => {
    if (!requireConnectionManager(req, res)) return;
    const { connection_id: connectionId, channel, to, text } = req.body || {};
    if (!to || !text) {
      return res.status(400).json({ error: 'missing_fields', message: 'to et text sont requis' });
    }
    try {
      // 1) Résolution de la connexion cible (par connection_id explicite, sinon par channel).
      let target;
      if (connectionId) {
        target = await db.getConnectionForApplication(req.application.id, connectionId);
        if (!target) {
          return res.status(404).json({ error: 'connection_not_found', message: 'Connexion inconnue pour cette application' });
        }
        if (channel && target.channel_type !== channel) {
          return res.status(400).json({ error: 'channel_mismatch', message: `La connexion "${connectionId}" n'est pas du canal "${channel}"` });
        }
      } else {
        const owned = await db.listConnectionsByApplication(req.application.id);
        const candidates = channel ? owned.filter((c) => c.channel_type === channel) : owned;
        if (candidates.length === 0) {
          return res.status(404).json({
            error: 'connection_not_found',
            message: channel
              ? `Aucune connexion de canal "${channel}" pour cette application`
              : 'Aucune connexion pour cette application',
          });
        }
        if (candidates.length > 1) {
          // Repli sur le canal par défaut de l'application quand aucun sélecteur n'est
          // fourni (ni connection_id ni channel) : on envoie via sa connexion par défaut.
          const defaultId = !channel ? req.application.default_connection_id : null;
          const chosen = defaultId ? candidates.find((c) => c.connection_id === defaultId) : null;
          if (!chosen) {
            return res.status(400).json({
              error: channel ? 'ambiguous_connection' : 'channel_required',
              message: channel
                ? `Plusieurs connexions de canal "${channel}" : précisez connection_id`
                : 'Plusieurs connexions : précisez channel (ou connection_id), ou définissez un canal par défaut',
            });
          }
          target = chosen;
        } else {
          target = candidates[0];
        }
      }

      const targetId = target.connection_id;
      // 2) Envoi via la session live, avec limite de débit et gestion du LID non résolu.
      const session = connectionManager.get(targetId);
      if (!session) {
        return res.status(409).json({ error: 'connection_not_active', message: 'Connexion non active (aucune session en cours)' });
      }
      // La session peut exister mais ne pas être encore connectée (ex. WhatsApp en attente de
      // scan QR, ou canal en cours d'initialisation) : dans ce cas l'envoi échouerait avec une
      // erreur générique (500). On renvoie plutôt le 409 contractuel connection_not_active.
      if (typeof session.isConnected === 'function' && !session.isConnected()) {
        return res.status(409).json({ error: 'connection_not_active', message: 'Connexion non active (canal non connecté)' });
      }
      const result = rateLimiter
        ? await rateLimiter.schedule(targetId, () => session.sendMessage(to, text))
        : await session.sendMessage(to, text);
      return res.status(200).json({ ...result, connectionId: targetId, channel: target.channel_type });
    } catch (err) {
      if (err instanceof LidUnresolvedError) {
        logger.warn({ to, lid: err.lid }, 'Envoi bloqué : LID non résolu');
        return res.status(422).json({
          error: 'lid_unresolved',
          message: `Le destinataire "${to}" n'a pas pu être résolu vers un identifiant réel. Message non envoyé.`,
          lid: err.lid,
        });
      }
      logger.error({ err: err.message, to }, 'Erreur envoi sortant /v1');
      return res.status(500).json({ error: 'Erreur interne' });
    }
  });

  // Liste des connexions de l'application appelante (état persisté + état live éventuel).
  app.get('/v1/connections', apiKeyAuth, async (req, res) => {
    try {
      const rows = await db.listConnectionsByApplication(req.application.id);
      const liveStates = connectionManager ? connectionManager.getAllStates() : {};
      const defaultConnectionId = req.application.default_connection_id || null;
      const connexions = rows.map((r) => ({
        connectionId: r.connection_id,
        channelType: r.channel_type,
        status: r.status,
        isDefault: r.connection_id === defaultConnectionId,
        state: liveStates[r.connection_id] || null,
      }));
      return res.status(200).json({ connexions, defaultConnectionId });
    } catch (err) {
      logger.error({ err: err.message }, 'Erreur liste connexions /v1');
      return res.status(500).json({ error: 'Erreur interne' });
    }
  });

  // Détail d'une connexion possédée par l'application appelante.
  app.get('/v1/connections/:connectionId', apiKeyAuth, async (req, res) => {
    try {
      const row = await db.getConnectionForApplication(req.application.id, req.params.connectionId);
      if (!row) return res.status(404).json({ error: 'connection_not_found' });
      const live = connectionManager ? connectionManager.get(req.params.connectionId) : null;
      return res.status(200).json({
        connectionId: row.connection_id,
        channelType: row.channel_type,
        status: row.status,
        state: live ? live.getState() : null,
      });
    } catch (err) {
      logger.error({ err: err.message, connectionId: req.params.connectionId }, 'Erreur détail connexion /v1');
      return res.status(500).json({ error: 'Erreur interne' });
    }
  });

  // QR code d'une connexion possédée par l'application appelante. Crée la session Baileys
  // (getOrCreate — idempotent) si nécessaire et retourne son état (qr, connected, status).
  // Alternative authentifiée par clé API à la route legacy /connections/:connectionId/qr
  // qui est désormais réservée au back-office admin (requireAdmin).
  app.get('/v1/connections/:connectionId/qr', apiKeyAuth, async (req, res) => {
    if (!connectionManager) {
      return res.status(503).json({ error: 'Gestionnaire de session non initialisé' });
    }
    try {
      const row = await db.getConnectionForApplication(req.application.id, req.params.connectionId);
      if (!row) return res.status(404).json({ error: 'connection_not_found' });
      const session = await connectionManager.getOrCreate(req.params.connectionId);
      await session.connect();
      return res.status(200).json(session.getState());
    } catch (err) {
      logger.error({ err: err.message, connectionId: req.params.connectionId }, 'Erreur récupération QR /v1');
      return res.status(500).json({ error: 'Erreur interne' });
    }
  });

  // Auto-provisioning (self-service) : une application enregistre SA propre connexion, scopée à
  // elle-même. Idempotent — renvoie l'existante si elle appartient déjà à l'app, refuse (409)
  // si elle appartient à une autre application. Permet le schéma « une connexion par
  // organisation » côté application, sans passer par le back-office admin.
  app.post('/v1/connections', apiKeyAuth, v1RateLimit, async (req, res) => {
    const { connectionId, channelType = 'whatsapp_baileys', credentials = null, webhookUrl = null } = req.body || {};
    if (!connectionId || typeof connectionId !== 'string') {
      return res.status(400).json({ error: 'bad_request', message: 'connectionId requis' });
    }
    if (adapterRegistry && typeof adapterRegistry.getAdapter === 'function' && !adapterRegistry.getAdapter(channelType)) {
      return res.status(400).json({ error: 'unknown_channel_type', message: `canal inconnu: ${channelType}` });
    }
    try {
      const existing = await db.getConnection(connectionId);
      if (existing && existing.application_id && existing.application_id !== req.application.id) {
        return res.status(409).json({ error: 'connection_conflict', message: 'connectionId déjà utilisé par une autre application' });
      }
      // Credentials optionnels (ex. token de bot Telegram). Self-service : une application peut,
      // avec sa SEULE clé API, enregistrer ET connecter sa connexion — sans passer par l'admin.
      // Chiffrés au repos (fail-closed : refus de stocker un secret sans coffre). Non fournis →
      // COALESCE en base préserve un token/webhook déjà présents (idempotent).
      const hasCreds = credentials && typeof credentials === 'object' && Object.keys(credentials).length > 0;
      let credentialsEncrypted;
      if (hasCreds) {
        if (!vault) {
          return res.status(400).json({ error: 'encryption_not_configured', message: 'CREDENTIALS_ENCRYPTION_KEY requis pour stocker des credentials' });
        }
        credentialsEncrypted = vault.encryptJson(credentials);
      }
      await db.upsertConnection({
        connectionId,
        channelType,
        applicationId: req.application.id,
        webhookUrl: webhookUrl || undefined,
        credentialsEncrypted,
        status: hasCreds ? 'initializing' : (existing ? existing.status : 'disconnected'),
      });
      // Si des credentials sont fournis, on tente la connexion live immédiate (getOrCreate +
      // connect). Pour Telegram : getMe valide le token puis démarre le long polling.
      let state = null;
      if (hasCreds && connectionManager) {
        try {
          const adapter = await connectionManager.getOrCreate(connectionId, { channelType, credentials });
          if (adapter && typeof adapter.connect === 'function') await adapter.connect();
          state = adapter && typeof adapter.getState === 'function' ? adapter.getState() : null;
        } catch (connErr) {
          logger.error({ err: connErr.message, connectionId }, 'Connexion live /v1 échouée');
          return res.status(502).json({ error: 'connect_failed', message: connErr.message, connectionId });
        }
      }
      return res.status(existing ? 200 : 201).json({ connectionId, channelType, applicationId: req.application.id, created: !existing, state });
    } catch (err) {
      logger.error({ err: err.message, connectionId }, 'Erreur création connexion /v1');
      return res.status(500).json({ error: 'Erreur interne' });
    }
  });

  // ==========================================================================
  // API interne worker (migration Django) : le plan de controle Django delegue l'envoi
  // sortant ICI. Authentifiee par l'en-tete X-Worker-Token (jamais exposee au client).
  // La resolution/scoping profil est faite en amont par Django ; le worker envoie sur la
  // connexion demandee via la session live existante (aucune session dupliquee).
  // ==========================================================================
  function requireWorkerToken(req, res, next) {
    if (!workerToken) return res.status(503).json({ error: 'worker_token_not_configured' });
    if (req.headers['x-worker-token'] !== workerToken) return res.status(401).json({ error: 'unauthorized' });
    return next();
  }

  app.post('/internal/send', requireWorkerToken, async (req, res) => {
    if (!requireConnectionManager(req, res)) return;
    const { connectionId, to, text } = req.body || {};
    if (!connectionId || !to || !text) {
      return res.status(400).json({ error: 'missing_fields', message: 'connectionId, to et text sont requis' });
    }
    const session = connectionManager.get(connectionId);
    if (!session) {
      return res.status(409).json({ error: 'connection_not_active', message: 'Connexion non active (aucune session en cours)' });
    }
    try {
      const result = rateLimiter
        ? await rateLimiter.schedule(connectionId, () => session.sendMessage(to, text))
        : await session.sendMessage(to, text);
      return res.status(200).json(result);
    } catch (err) {
      if (err instanceof LidUnresolvedError) {
        return res.status(422).json({ error: 'lid_unresolved', lid: err.lid });
      }
      logger.error({ err: err.message, connectionId }, 'Envoi interne worker echoue');
      return res.status(500).json({ error: 'send_failed' });
    }
  });

  // ==========================================================================
  // Webhook entrant WhatsApp Cloud API (Meta) — Task 8.
  // Meta POUSSE les messages ici (pas de polling). GET = vérification du webhook,
  // POST = événements (messages entrants + accusés de statut). Routes PUBLIQUES
  // (appelées par Meta) : sécurisées par verify_token (GET) et signature HMAC
  // X-Hub-Signature-256 (POST), pas par clé API.
  // ==========================================================================
  app.get('/webhooks/whatsapp-cloud', (req, res) => {
    const verifyToken = whatsappCloud && whatsappCloud.verifyToken;
    const result = checkVerification(req.query, verifyToken);
    if (result.ok) return res.status(200).send(result.challenge);
    return res.status(403).json({ error: 'verification_failed' });
  });

  app.post('/webhooks/whatsapp-cloud', async (req, res) => {
    const appSecret = whatsappCloud && whatsappCloud.appSecret;
    if (appSecret) {
      if (!verifyMetaSignature(req.rawBody, req.headers['x-hub-signature-256'], appSecret)) {
        return res.status(401).json({ error: 'invalid_signature' });
      }
    } else {
      logger.warn('Webhook WhatsApp Cloud reçu sans vérification de signature (WHATSAPP_CLOUD_APP_SECRET non configuré)');
    }
    // On répond 200 rapidement à Meta ; le traitement des événements est best-effort.
    try {
      const events = extractInboundEvents(req.body);
      for (const ev of events) {
        if (!ev.phoneNumberId || !connectionManager || typeof connectionManager.findByChannelRef !== 'function') continue;
        const adapter = connectionManager.findByChannelRef('whatsapp_cloud', ev.phoneNumberId);
        if (adapter && typeof adapter.ingestWebhook === 'function') {
          await adapter.ingestWebhook(ev.value);
        }
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Erreur traitement webhook WhatsApp Cloud');
    }
    return res.status(200).json({ received: true });
  });

  return app;
}

module.exports = createApp;
