'use strict';

/**
 * Configuration par variables d'environnement, dédiée à rs-connector.
 * rs-connector est un service indépendant : il ne partage AUCUNE variable d'environnement,
 * base de données ni volume avec les autres services (deskassit, desklink, etc.).
 */

function required(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    return undefined;
  }
  return value;
}

const config = {
  // Port HTTP interne du service (exposé au conteneur, mappé côté hôte par docker-compose).
  port: parseInt(required('PORT', '3007'), 10),

  // Niveau de log pino (trace|debug|info|warn|error|fatal).
  logLevel: required('LOG_LEVEL', 'info'),

  // Répertoire racine des données d'auth des canaux (ex. auth Baileys), une
  // sous-arborescence par connexion. Toujours un volume Docker dédié à rs-connector.
  authDir: required('AUTH_DIR', '/data/auth'),

  // Secret HMAC global de repli pour signer les webhooks sortants (v1). À terme, chaque
  // application branchée disposera de son propre secret (voir PLAN-TACHES.md, multi-app).
  webhookSecret: required('WEBHOOK_SECRET', ''),

  // URL webhook de repli utilisée quand une connexion/application n'en configure pas.
  defaultWebhookUrl: required('DEFAULT_WEBHOOK_URL', ''),

  // URL publique de base du service (ex. https://rs-connector.example.com), indiquée aux applications
  // comme endpoint à appeler. Vide ⇒ déduite de la requête (peu fiable derrière un proxy).
  publicBaseUrl: required('PUBLIC_BASE_URL', ''),

  // Anti-abus : nombre max de requêtes /v1/messages par application et par minute (0 = désactivé).
  // Défaut généreux : protège d'une boucle/fuite de clé sans gêner un usage normal.
  v1RateLimitPerMin: parseInt(required('V1_RATE_LIMIT_PER_MIN', '240'), 10),

  // WhatsApp Cloud API (Meta) — Task 8. verifyToken : validation GET du webhook ;
  // appSecret : vérification HMAC (X-Hub-Signature-256) des POST entrants ;
  // graphVersion : version de l'API Graph.
  whatsappCloud: {
    verifyToken: required('WHATSAPP_CLOUD_VERIFY_TOKEN', ''),
    appSecret: required('WHATSAPP_CLOUD_APP_SECRET', ''),
    graphVersion: required('WHATSAPP_CLOUD_GRAPH_VERSION', 'v21.0'),
  },

  // Back-office sécurisé (Task 9). issuer : libellé dans l'app d'authentification TOTP ;
  // sessionTtlSeconds : durée de vie d'une session ; cookieSecure : flag Secure du cookie
  // (true en prod HTTPS ; mettre ADMIN_COOKIE_SECURE=false en dev HTTP local).
  admin: {
    issuer: required('ADMIN_TOTP_ISSUER', 'rs-connector'),
    sessionTtlSeconds: parseInt(required('ADMIN_SESSION_TTL', '43200'), 10),
    cookieSecure: required('ADMIN_COOKIE_SECURE', 'true') !== 'false',
  },

  // SMTP système pour les emails transactionnels (vérification d'email des comptes utilisateurs).
  // Absent (SYSTEM_SMTP_HOST vide) ⇒ vérification désactivée, comptes auto-vérifiés (dégradation gracieuse).
  systemSmtp: (() => {
    const host = required('SYSTEM_SMTP_HOST', '');
    if (!host) return null;
    const user = required('SYSTEM_SMTP_USER', '');
    return {
      host,
      port: parseInt(required('SYSTEM_SMTP_PORT', '465'), 10),
      secure: required('SYSTEM_SMTP_SECURE', 'true') !== 'false',
      user,
      pass: required('SYSTEM_SMTP_PASS', ''),
      from: required('SYSTEM_SMTP_FROM', user),
    };
  })(),

  // Clé de chiffrement AES-256-GCM des credentials au repos (Task 11) : 32 octets en
  // base64/hex, injectée hors DB. Vide ⇒ la création de connexions avec secrets est
  // refusée (fail-closed).
  credentialsKey: required('CREDENTIALS_ENCRYPTION_KEY', ''),

  // Base Postgres dédiée à rs-connector : état des connexions, messages, contacts, outbox.
  // Totalement séparée des bases des autres services.
  database: {
    host: required('DB_HOST', 'localhost'),
    port: parseInt(required('DB_PORT', '5432'), 10),
    database: required('DB_NAME', 'rs_connector'),
    user: required('DB_USER', 'rs_connector'),
    password: required('DB_PASSWORD', ''),
  },
};

module.exports = config;
