'use strict';

const { Pool } = require('pg');
const fs = require('fs/promises');
const path = require('path');

const createApp = require('./app');
const config = require('./config');
const logger = require('./logger');
const { createRealConnectionManager } = require('./connection-manager-factory');
const { createDb } = require('./db');
const { createRateLimiter } = require('./rate-limiter');
const { createWebhookSigner } = require('./webhook-signer');
const { createWebhookDispatcher } = require('./webhook-dispatcher');
const { restoreKnownSessions } = require('./session-restore');
const { createVault } = require('./crypto-vault');

const WEBHOOK_POLL_INTERVAL_MS = 10_000;

async function main() {
  const pool = new Pool(config.database);
  const db = createDb(pool);

  const schemaSql = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.init(schemaSql);
  logger.info('Schéma de base de données initialisé (connections, messages_status, outbox_webhooks)');

  // Task 6 : dispatcher de webhooks sortants, avec outbox DB persistante (correctif
  // intégré dès le départ — voir PLAN-TACHES.md). `fetch` natif de Node 20+ est injecté
  // comme fetchFn, pour rester cohérent avec le pattern d'injection de dépendances du
  // reste du projet (testable avec un mock sans vrai réseau).
  const webhookSigner = createWebhookSigner({ crypto: require('node:crypto') });
  const webhookDispatcher = createWebhookDispatcher({
    db,
    webhookSigner,
    fetchFn: fetch,
    logger,
  });

  const connectionManager = createRealConnectionManager(config.authDir, db, webhookDispatcher);
  const rateLimiter = createRateLimiter();

  // Coffre de chiffrement des credentials au repos (Task 11). Absent si la clé n'est pas
  // configurée : la création de connexions avec secrets sera refusée (fail-closed).
  const vault = config.credentialsKey ? createVault(config.credentialsKey) : null;
  if (!vault) {
    logger.warn('CREDENTIALS_ENCRYPTION_KEY non configurée : chiffrement des credentials désactivé');
  }

  // Correctif post-relecture critique : restauration des connections connues au démarrage
  // (voir session-restore.js — module extrait et testé en important le vrai code).
  await restoreKnownSessions(db, connectionManager, logger, vault);

  // Task 6 : polling périodique de l'outbox — relit les webhooks pending échus et
  // tente leur envoi. L'URL par connexion vient de sa configuration en DB
  // (connections.webhook_url), avec repli sur DEFAULT_WEBHOOK_URL si non configurée
  // individuellement. Le secret HMAC reste global (WEBHOOK_SECRET) pour la v1.
  async function buildConnectionWebhookConfig() {
    const targets = await db.listConnectionWebhookTargets();
    const map = new Map();
    for (const t of targets) {
      const webhookUrl = t.webhook_url || config.defaultWebhookUrl || null;
      if (webhookUrl) {
        // Secret propre à l'application (repli sur le secret global si l'app n'en a pas).
        map.set(t.connection_id, { webhookUrl, secret: t.webhook_secret || config.webhookSecret });
      }
    }
    return map;
  }

  let webhookPollTimer = null;
  async function pollWebhookOutbox() {
    try {
      const connectionConfig = await buildConnectionWebhookConfig();
      const result = await webhookDispatcher.processQueue(connectionConfig);
      if (result.sent || result.failed || result.skipped) {
        logger.info(result, 'Passage du dispatcher de webhooks sortants');
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Erreur pendant le traitement de la file de webhooks sortants');
    } finally {
      webhookPollTimer = setTimeout(pollWebhookOutbox, WEBHOOK_POLL_INTERVAL_MS);
    }
  }
  webhookPollTimer = setTimeout(pollWebhookOutbox, WEBHOOK_POLL_INTERVAL_MS);

  const app = createApp({ connectionManager, db, rateLimiter, webhookSigner, whatsappCloud: config.whatsappCloud, admin: config.admin, vault, publicBaseUrl: config.publicBaseUrl, v1RateLimitPerMin: config.v1RateLimitPerMin });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'rs-connector démarré');
  });

  function shutdown(signal) {
    logger.info({ signal }, 'Arrêt du service demandé');
    if (webhookPollTimer) clearTimeout(webhookPollTimer);
    server.close(async () => {
      await db.close().catch(() => {});
      logger.info('Service arrêté proprement');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

module.exports = main();
