-- Schéma initial de rs-connector (état des connexions de canal, statuts de message, contacts, outbox).
-- Base dédiée exclusivement à ce service — aucune table ERP/CRM/IA ici, uniquement
-- l'état des connections WhatsApp et le suivi des statuts de message.

CREATE TABLE IF NOT EXISTS applications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL UNIQUE,
  api_key_prefix  TEXT NOT NULL,
  webhook_url     TEXT,
  webhook_secret  TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_applications_api_key_hash ON applications(api_key_hash);

CREATE TABLE IF NOT EXISTS connections (
  connection_id     TEXT PRIMARY KEY,
  channel_type    TEXT NOT NULL DEFAULT 'whatsapp_baileys',
  application_id  UUID REFERENCES applications(id) ON DELETE CASCADE,
  credentials_encrypted TEXT,
  phone_number    TEXT,
  status          TEXT NOT NULL DEFAULT 'initializing',
  qr_code         TEXT,
  webhook_url     TEXT,
  last_connected_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table préparée pour la Task 4 (state machine des statuts de message + accusés de
-- livraison) : chaque transition sera stockée comme un événement horodaté distinct,
-- pas comme un champ simplement écrasé. Créée dès la Task 3 pour que le schéma de base
-- de données soit posé une fois, complété ensuite.
CREATE TABLE IF NOT EXISTS messages_status (
  id              BIGSERIAL PRIMARY KEY,
  connection_id     TEXT NOT NULL REFERENCES connections(connection_id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,
  status          TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_status_message_id ON messages_status(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_status_connection_id ON messages_status(connection_id);

-- Migration idempotente : la colonne webhook_url a été ajoutée après la création initiale
-- du schéma (Task 6). `CREATE TABLE IF NOT EXISTS` ne modifie jamais une table existante,
-- donc ALTER TABLE est nécessaire pour les bases déjà initialisées avant cette Task.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS webhook_url TEXT;

-- Migration idempotente : channel_type identifie le canal d'une connexion
-- (whatsapp_baileys | whatsapp_cloud | telegram | email | ...). Défaut whatsapp_baileys
-- pour rester rétrocompatible avec les connexions créées avant le multi-canal.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS channel_type TEXT NOT NULL DEFAULT 'whatsapp_baileys';

-- Migration idempotente : rattachement d'une connexion à une application (multi-app, Task 5).
ALTER TABLE connections ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;

-- Migration idempotente : credentials de canal chiffrés au repos (AES-GCM, Task 11).
ALTER TABLE connections ADD COLUMN IF NOT EXISTS credentials_encrypted TEXT;

-- Canal par défaut d'une application : connexion utilisée par /v1/messages quand l'appel
-- ne précise NI connection_id NI channel (repli). ON DELETE SET NULL : si la connexion
-- par défaut est supprimée, l'application repasse simplement "sans défaut" (pas d'erreur).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS default_connection_id TEXT REFERENCES connections(connection_id) ON DELETE SET NULL;

-- Correctif post-relecture critique (voir SUIVI-AVANCEMENT.md, section "Task 4/5 rouvertes") :
-- cache persistant du mapping LID->numéro réel, par connexion. Alimente le contact-resolver
-- (Task 5) sans relire les fichiers d'auth Baileys à chaque envoi, et est mis à jour aussi
-- bien à la lecture d'un fichier de mapping qu'à la réception d'un message entrant (Baileys
-- fournit souvent le LID réel dès l'événement messages.upsert).
CREATE TABLE IF NOT EXISTS contacts (
  connection_id     TEXT NOT NULL REFERENCES connections(connection_id) ON DELETE CASCADE,
  lid             TEXT NOT NULL,
  phone_number    TEXT NOT NULL,
  resolved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, lid)
);

-- Correctif post-relecture critique : les transitions de statut invalides (ex. Baileys
-- renvoie un statut hors-séquence ou contradictoire) ne doivent plus se limiter à un
-- logger.warn qui se noie dans les logs JSON. Elles sont désormais persistées ici, dans
-- un état consultable (voir GET /messages/:messageId/status-history qui les inclut).
CREATE TABLE IF NOT EXISTS message_status_anomalies (
  id              BIGSERIAL PRIMARY KEY,
  connection_id     TEXT NOT NULL REFERENCES connections(connection_id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,
  from_status      TEXT,
  attempted_status TEXT NOT NULL,
  reason          TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_status_anomalies_message_id ON message_status_anomalies(message_id);
CREATE INDEX IF NOT EXISTS idx_message_status_anomalies_connection_id ON message_status_anomalies(connection_id);

-- Task 6 : outbox persistante pour les webhooks sortants (correctif intégré dès le départ,
-- voir PLAN-TACHES.md "AJUSTEMENT"). Chaque événement à notifier (message entrant, accusé
-- de statut, connexion/déconnexion de session) est écrit ICI avant toute tentative d'envoi
-- HTTP. Un crash ou redémarrage du conteneur pendant un backoff ne perd donc jamais
-- l'événement : il reste `pending` et sera retenté au prochain passage du dispatcher.
CREATE TABLE IF NOT EXISTS outbox_webhooks (
  id              BIGSERIAL PRIMARY KEY,
  connection_id     TEXT NOT NULL REFERENCES connections(connection_id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_retry_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_webhooks_status_retry ON outbox_webhooks(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_outbox_webhooks_connection_id ON outbox_webhooks(connection_id);

-- Back-office sécurisé (Task 9) : comptes admin, sessions, tentatives de login.
-- totp_secret sera chiffré au repos en Task 11 (aujourd'hui stocké tel quel).
CREATE TABLE IF NOT EXISTS admin_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret   TEXT,
  totp_enabled  BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- id = SHA-256 du token de session (le token brut n'est jamais stocké).
CREATE TABLE IF NOT EXISTS admin_sessions (
  id            TEXT PRIMARY KEY,
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_token    TEXT NOT NULL,
  otp_verified  BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(admin_user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  username      TEXT PRIMARY KEY,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
