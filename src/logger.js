'use strict';

const pino = require('pino');
const config = require('./config');

/**
 * Logger structuré JSON (pino), dès le démarrage du service — pas ajouté après coup.
 * Chaque ligne de log est un objet JSON exploitable par un futur agrégateur de logs.
 */
const logger = pino({
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: 'rs-connector' },
});

module.exports = logger;
