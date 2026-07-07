'use strict';

/**
 * Dispatcher de webhooks sortants (Task 6), avec outbox DB persistante — correctif
 * intégré dès le départ (voir PLAN-TACHES.md, section "AJUSTEMENT" Task 6).
 *
 * Principe : AUCUN événement n'est envoyé directement en HTTP au moment où il se
 * produit. Il est d'abord écrit dans `outbox_webhooks` (statut `pending`), puis
 * `processQueue()` (appelée en polling périodique, voir index.js) relit les entrées
 * dues et tente l'envoi. Si le conteneur crashe entre l'écriture et l'envoi, ou pendant
 * un backoff, l'événement reste `pending` en DB et sera retenté au redémarrage suivant
 * — aucune perte silencieuse, contrairement à une simple promesse en mémoire.
 *
 * Pas d'event broker (Redis/RabbitMQ/Kafka) : le volume actuel ne le justifie pas
 * (voir AUDIT.md et SUIVI-AVANCEMENT.md, section "amélioration future").
 */

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000; // 5 minutes

/**
 * @param {object} deps
 * @param {object} deps.db - Instance db.js (enqueueWebhook, getPendingWebhooks, etc.).
 * @param {object} deps.webhookSigner - Instance webhook-signer.js (sign).
 * @param {Function} deps.fetchFn - Fonction fetch-like : (url, options) => Promise<Response>.
 *   Injectée pour rester testable sans dépendre d'un vrai réseau (ex. mock en test).
 * @param {object} deps.logger - Logger pino (ou mock).
 * @param {Function} [deps.now] - Horloge injectable (par défaut Date.now), pour des
 *   tests déterministes du calcul de backoff.
 * @param {object} [options]
 * @param {number} [options.maxAttempts] - Nombre max de tentatives avant `failed_permanent`.
 * @param {number} [options.baseDelayMs] - Délai de base du backoff exponentiel.
 * @param {number} [options.maxDelayMs] - Plafond du délai de backoff.
 */
function createWebhookDispatcher(deps, options = {}) {
  const { db, webhookSigner, fetchFn, logger, now = () => Date.now() } = deps;
  const maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs || DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs || DEFAULT_MAX_DELAY_MS;

  /**
   * Enregistre un événement à notifier. TOUJOURS appelé avant tout envoi HTTP —
   * c'est la garantie anti-perte de cette Task.
   *
   * @param {string} connectionId
   * @param {string} eventType - Ex. "message.received", "message.status_changed",
   *   "session.connected", "session.disconnected".
   * @param {object} payload - Corps de l'événement (sera signé et envoyé tel quel).
   */
  async function enqueue(connectionId, eventType, payload) {
    return db.enqueueWebhook({ connectionId, eventType, payload });
  }

  function computeBackoffDelay(attempts) {
    const delay = baseDelayMs * 2 ** attempts;
    return Math.min(delay, maxDelayMs);
  }

  /**
   * Tente l'envoi HTTP signé d'un événement de l'outbox vers l'URL configurée pour sa
   * connexion. Ne lève jamais d'exception vers l'appelant : le succès/échec est
   * entièrement reflété dans le retour et dans l'état persisté en DB.
   */
  async function attemptDelivery(webhook, webhookUrl, secret) {
    const body = JSON.stringify(webhook.payload);
    const signature = webhookSigner.sign(body, secret);

    const response = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': webhook.event_type,
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Réponse HTTP ${response.status} du destinataire du webhook`);
    }
  }

  /**
   * Relit les webhooks `pending` dus (next_retry_at <= now) et tente leur envoi.
   * Chaque webhook est traité indépendamment : l'échec de l'un n'empêche jamais le
   * traitement des autres.
   *
   * @param {Map<string,{webhookUrl:string,secret:string}>} connectionConfig - Config
   *   webhook (URL + secret HMAC) par connection_id, nécessaire pour savoir où/comment
   *   signer chaque envoi.
   */
  async function processQueue(connectionConfig, limit = 50) {
    const pending = await db.getPendingWebhooks(limit);
    const results = { sent: 0, failed: 0, skipped: 0 };

    for (const webhook of pending) {
      const config = connectionConfig.get(webhook.connection_id);
      if (!config || !config.webhookUrl) {
        // Aucune URL configurée pour cette connexion : on ne peut pas livrer, mais on ne
        // doit pas non plus boucler indéfiniment dessus à chaque passage — repousser
        // l'échéance sans compter comme un vrai échec réseau.
        await db.markWebhookFailed(webhook.id, {
          reason: 'Aucune URL webhook configurée pour cette connexion',
          nextRetryAt: new Date(now() + maxDelayMs),
          permanent: false,
        });
        results.skipped++;
        continue;
      }

      try {
        await attemptDelivery(webhook, config.webhookUrl, config.secret);
        await db.markWebhookSent(webhook.id);
        results.sent++;
      } catch (err) {
        const nextAttempts = webhook.attempts + 1;
        const permanent = nextAttempts >= maxAttempts;
        logger.warn(
          { err: err.message, webhookId: webhook.id, connectionId: webhook.connection_id, attempt: nextAttempts, permanent },
          permanent ? 'Webhook définitivement en échec (seuil de tentatives atteint)' : 'Échec envoi webhook, retry planifié',
        );
        await db.markWebhookFailed(webhook.id, {
          reason: err.message,
          nextRetryAt: permanent ? null : new Date(now() + computeBackoffDelay(webhook.attempts)),
          permanent,
        });
        results.failed++;
      }
    }

    return results;
  }

  return { enqueue, processQueue, computeBackoffDelay };
}

module.exports = { createWebhookDispatcher, DEFAULT_MAX_ATTEMPTS, DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS };
