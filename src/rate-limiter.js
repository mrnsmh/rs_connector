'use strict';

/**
 * Rate limiter par connexion (Task 5) : point complémentaire identifié dans l'AUDIT.md
 * ("Aucune limite de débit sur l'envoi sortant WhatsApp — risque de bannissement du
 * numéro"). Une file d'attente simple par connection_id impose un espacement minimal
 * entre deux envois consécutifs sur le même numéro. Volontairement basique : pas de
 * système de quotas complexe, juste un espacement anti-rafale.
 *
 * Chaque connexion a sa propre file, totalement indépendante des autres — l'envoi
 * intensif sur une connexion ne ralentit jamais les envois d'une autre.
 */

const DEFAULT_MIN_INTERVAL_MS = 1_500;

/**
 * @param {object} [deps]
 * @param {Function} [deps.now] - Horloge injectable (Date.now par défaut), pour les tests.
 * @param {Function} [deps.setTimeout] - setTimeout injectable, pour les tests.
 * @param {object} [options]
 * @param {number} [options.minIntervalMs] - Espacement minimal entre deux envois (défaut 1500ms).
 */
function createRateLimiter(deps = {}, options = {}) {
  const now = deps.now || Date.now;
  const scheduleTimeout = deps.setTimeout || setTimeout;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  // connection_id -> { lastSentAt, queue: Promise } — chaque connexion a sa propre chaîne
  // de promesses garantissant l'espacement, sans bloquer les autres connexions.
  const lastSentAtByConnection = new Map();
  const queueTailByConnection = new Map();

  function wait(ms) {
    return new Promise((resolve) => scheduleTimeout(resolve, ms));
  }

  /**
   * Exécute `fn` en respectant l'espacement minimal pour cette connexion. Les appels
   * concurrents pour la MÊME connexion sont sérialisés et espacés ; les appels pour des
   * connexions différentes s'exécutent en parallèle, sans attendre les unes les autres.
   */
  function schedule(connectionId, fn) {
    const previousTail = queueTailByConnection.get(connectionId) || Promise.resolve();

    const task = previousTail.then(async () => {
      const lastSentAt = lastSentAtByConnection.has(connectionId) ? lastSentAtByConnection.get(connectionId) : null;
      if (lastSentAt !== null) {
        const elapsed = now() - lastSentAt;
        if (elapsed < minIntervalMs) {
          await wait(minIntervalMs - elapsed);
        }
      }
      lastSentAtByConnection.set(connectionId, now());
      return fn();
    });

    // La queue continue même si `task` rejette, pour ne pas bloquer les envois suivants
    // de la même connexion après un échec ponctuel.
    queueTailByConnection.set(connectionId, task.catch(() => {}));

    return task;
  }

  function getLastSentAt(connectionId) {
    return lastSentAtByConnection.has(connectionId) ? lastSentAtByConnection.get(connectionId) : null;
  }

  return { schedule, getLastSentAt, minIntervalMs };
}

module.exports = { createRateLimiter, DEFAULT_MIN_INTERVAL_MS };
