'use strict';

/**
 * Restauration des connections connues au démarrage (Task 6, correctif post-relecture
 * critique). Extrait de index.js pour être testable en isolation en important le VRAI
 * code (et non une copie recopiée dans le fichier de test).
 *
 * Sans cette restauration, un redémarrage du conteneur (mise à jour, OOM, redeploy)
 * obligeait à rescanner manuellement le QR de CHAQUE connexion déjà connectée — la DB
 * savait quelles connections étaient connectées, mais rien ne s'en servait pour
 * reconstruire les sockets Baileys automatiquement.
 *
 * Les statuts `logged_out`/`possibly_banned` sont volontairement EXCLUS de la
 * restauration automatique : ils nécessitent une action humaine (rescanner un nouveau
 * QR), pas une reconnexion muette.
 */

// Statuts dont le dernier état connu justifie une tentative de reconnexion automatique.
const RESTORABLE_STATUSES = ['connected', 'qr_required', 'connecting', 'disconnected'];

/**
 * @param {object} db - Instance db.js (doit exposer listConnections()).
 * @param {object} connectionManager - Gestionnaire de connections (doit exposer getOrCreate()).
 * @param {object} logger - Logger pino (ou mock).
 */
async function restoreKnownSessions(db, connectionManager, logger, vault = null) {
  let connections = [];
  try {
    connections = await db.listConnections();
  } catch (err) {
    logger.error({ err: err.message }, 'Impossible de lister les connections existantes pour restauration');
    return;
  }

  const toRestore = connections.filter((s) => RESTORABLE_STATUSES.includes(s.status));
  if (toRestore.length === 0) {
    logger.info('Aucune session à restaurer au démarrage');
    return;
  }

  logger.info(
    { count: toRestore.length, connexions: toRestore.map((s) => s.connection_id) },
    'Restauration des connections connues au démarrage',
  );

  for (const s of toRestore) {
    try {
      let credentials;
      if (vault && s.credentials_encrypted) {
        try {
          credentials = vault.decryptJson(s.credentials_encrypted);
        } catch (err) {
          logger.error({ err: err.message, connectionId: s.connection_id }, 'Déchiffrement des credentials échoué (restauration)');
        }
      }
      const session = await connectionManager.getOrCreate(s.connection_id, { channelType: s.channel_type, credentials });
      await session.connect();
    } catch (err) {
      logger.error({ err: err.message, connectionId: s.connection_id }, 'Échec de restauration automatique de la session');
    }
  }
}

module.exports = { restoreKnownSessions, RESTORABLE_STATUSES };
