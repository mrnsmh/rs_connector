'use strict';

/**
 * Middleware d'authentification par clé API pour l'API d'entrée multi-app (/v1, Task 5).
 *
 * L'application cliente présente sa clé via `Authorization: Bearer <clé>`. rs-connector en calcule
 * le hash SHA-256 et cherche l'application correspondante en base. En cas de succès,
 * `req.application` est renseignée et sert au scoping (une app ne voit que ses connexions).
 *
 * Aucune comparaison de secret en clair : on hache la clé présentée puis on cherche par hash.
 */

const { hashApiKey } = require('./api-key');

/** Extrait le token d'un en-tête `Authorization: Bearer <token>` (ou null). */
function extractBearer(req) {
  const header = (req.headers && req.headers.authorization) || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : null;
}

/**
 * @param {object} db - Instance db.js (doit exposer getApplicationByApiKeyHash()).
 * @returns {Function} middleware Express (req, res, next).
 */
function createApiKeyAuth(db) {
  return async function apiKeyAuth(req, res, next) {
    if (!db) {
      return res.status(503).json({ error: 'Base de données non initialisée' });
    }
    const apiKey = extractBearer(req);
    if (!apiKey) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Clé API requise (en-tête Authorization: Bearer <clé>)',
      });
    }
    try {
      const application = await db.getApplicationByApiKeyHash(hashApiKey(apiKey));
      if (!application || application.status === 'disabled') {
        return res.status(401).json({ error: 'unauthorized', message: 'Clé API invalide ou application désactivée' });
      }
      req.application = application;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { createApiKeyAuth, extractBearer };
