'use strict';

/**
 * Pont ESM → CommonJS pour le package `@whtsp/core` (ESM uniquement, `"type": "module"`).
 *
 * rs-connector est CommonJS : un `require('@whtsp/core')` direct échouerait
 * (ERR_REQUIRE_ESM). Ce loader fait un import dynamique memoïsé : le module ESM n'est
 * chargé qu'une seule fois, et tous les appelants partagent la même instance.
 *
 * Toute utilisation de `@whtsp/core` DOIT passer par `loadWhtsp()` — jamais par
 * `require('@whtsp/core')` direct.
 */

let cachedModule = null;

/**
 * @returns {Promise<typeof import('@whtsp/core')>} Le module ESM de @whtsp/core, chargé une seule fois.
 */
async function loadWhtsp() {
  if (!cachedModule) {
    cachedModule = await import('@whtsp/core');
  }
  return cachedModule;
}

/** Réinitialise le cache (utile en test pour injecter une fausse implémentation). */
function resetWhtspLoader() {
  cachedModule = null;
}

/** Test-only : injecte une fausse implémentation du module @whtsp/core. */
function setWhtspModule(mockModule) {
  cachedModule = mockModule;
}

module.exports = { loadWhtsp, resetWhtspLoader, setWhtspModule };
