'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, DEFAULT_MIN_INTERVAL_MS } = require('../src/rate-limiter');

/**
 * Horloge et setTimeout injectables déterministes : le temps avance uniquement quand
 * on appelle explicitement `clock.advance(ms)` — aucun vrai délai n'est jamais attendu,
 * les tests sont donc rapides et déterministes.
 */
function buildFakeClock() {
  let currentTime = 0;
  const pendingTimers = [];

  return {
    now: () => currentTime,
    setTimeout: (fn, delay) => {
      pendingTimers.push({ fn, at: currentTime + delay });
      return pendingTimers.length;
    },
    advance(ms) {
      currentTime += ms;
      const due = pendingTimers.filter((t) => t.at <= currentTime);
      for (const t of due) {
        pendingTimers.splice(pendingTimers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

test('le premier envoi pour une connexion n\'attend jamais (pas de délai initial)', async () => {
  const clock = buildFakeClock();
  const limiter = createRateLimiter({ now: clock.now, setTimeout: clock.setTimeout });

  const order = [];
  const promise = limiter.schedule('b1', () => { order.push('sent'); return 'result'; });

  await promise;
  assert.deepEqual(order, ['sent']);
});

test('deux envois consécutifs sur la même connexion respectent l\'espacement minimal', async () => {
  const clock = buildFakeClock();
  const limiter = createRateLimiter({ now: clock.now, setTimeout: clock.setTimeout }, { minIntervalMs: 1500 });

  const timestamps = [];
  const p1 = limiter.schedule('b1', () => { timestamps.push(clock.now()); });

  await p1;
  const p2 = limiter.schedule('b1', () => { timestamps.push(clock.now()); });

  // Sans avancer l'horloge, le 2e envoi doit être en attente (espacement non satisfait).
  // On avance le temps exactement de l'espacement minimal pour débloquer le timer.
  clock.advance(1500);
  await p2;

  assert.equal(timestamps.length, 2);
  assert.equal(timestamps[1] - timestamps[0], 1500);
});

test('deux connexions différentes n\'attendent jamais l\'une pour l\'autre', async () => {
  const clock = buildFakeClock();
  const limiter = createRateLimiter({ now: clock.now, setTimeout: clock.setTimeout }, { minIntervalMs: 1500 });

  const order = [];
  const pA = limiter.schedule('connexion-a', () => { order.push('a'); });
  const pB = limiter.schedule('connexion-b', () => { order.push('b'); });

  await Promise.all([pA, pB]);

  // Les deux connexions s'exécutent immédiatement, sans attendre l'espacement de l'autre.
  assert.deepEqual(order.sort(), ['a', 'b']);
});

test('un échec sur une tâche ne bloque pas les tâches suivantes de la même connexion', async () => {
  const clock = buildFakeClock();
  const limiter = createRateLimiter({ now: clock.now, setTimeout: clock.setTimeout }, { minIntervalMs: 100 });

  const results = [];
  const p1 = limiter.schedule('b1', () => { throw new Error('échec simulé'); });
  await assert.rejects(p1);

  clock.advance(100);
  const p2 = limiter.schedule('b1', () => { results.push('ok'); return 'ok'; });
  await p2;

  assert.deepEqual(results, ['ok']);
});

test('espacement par défaut est bien 1500ms si non spécifié', () => {
  const limiter = createRateLimiter();
  assert.equal(limiter.minIntervalMs, DEFAULT_MIN_INTERVAL_MS);
  assert.equal(DEFAULT_MIN_INTERVAL_MS, 1500);
});

test('getLastSentAt reflète le dernier envoi effectif pour une connexion', async () => {
  const clock = buildFakeClock();
  const limiter = createRateLimiter({ now: clock.now, setTimeout: clock.setTimeout });

  assert.equal(limiter.getLastSentAt('b1'), null);

  await limiter.schedule('b1', () => {});
  assert.equal(limiter.getLastSentAt('b1'), 0);
});
