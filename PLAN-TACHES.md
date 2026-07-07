# rs-connector — Plan de tâches & architecture

> **rs-connector** est un hub de messagerie **multi-canal**, **indépendant**, qu'on branche sur
> **plusieurs applications** clientes. Il gère les connexions à des canaux (WhatsApp,
> Telegram, Email, …), normalise les messages entrants/sortants, et notifie chaque
> application via des **webhooks signés**. Un **back-office sécurisé** (frontend séparé,
> mot de passe + OTP) permet de configurer les comptes de canal.
>
> Cloné depuis `wa-gateway-desklink` (passerelle WhatsApp/Baileys dédiée à desklink), qui
> **reste intact**. rs-connector généralise ce socle sans jamais toucher au projet d'origine.

---

## 1. Principes directeurs

1. **Indépendance totale** — aucune ressource partagée (base, volume, réseau, variable
   d'env) avec les autres services. Base Postgres dédiée `rs-connector`, volumes dédiés.
2. **Sécurité par défaut** — credentials de canal **chiffrés au repos** (AES-GCM, clé hors
   DB) ; back-office protégé par mot de passe + **OTP TOTP** ; webhooks **signés HMAC** ;
   API d'entrée authentifiée par **clé API** par application.
3. **Testabilité** — injection de dépendances partout (héritée du socle). Toute logique est
   testable sans réseau réel (Baileys, fetch, SMTP… mockés). On conserve les tests verts à
   chaque étape.
4. **Abstraction de canal** — le cœur ne connaît pas les spécificités d'un canal ; chaque
   canal est un **adaptateur** implémentant une interface commune.

---

## 2. Décisions validées (2026-07-04)

| # | Décision | Choix retenu |
|---|----------|--------------|
| 1 | Back-office | **Frontend séparé** (SPA) + API d'admin sécurisée côté rs-connector |
| 2 | Portée d'une connexion | **Une connexion appartient à une seule application** ; modèle prévu pour évoluer vers le partage multi-app plus tard |
| 3 | WhatsApp | **Baileys conservé** + **adaptateur Meta Cloud API** (config officielle) en complément |
| 4 | Base de données | **Base dédiée `rs-connector`**, indépendante du reste |
| 5 | Vague 1 des canaux | **Telegram + Email** d'abord |
| 6 | Chiffrement credentials | **AES-GCM au repos, clé injectée hors DB** — validé dès le départ |

---

## 3. Architecture cible

```
                 ┌─────────────────────────────────────────────┐
   App A ───▶     │  API d'entrée (clé API par app)             │
   App B ───▶     │   POST /v1/messages  (envoi sortant)        │
                 │                                             │
                 │  ┌────────────────────────────────────────┐ │
                 │  │  Connection Manager (par connection_id) │ │
                 │  │   registre d'adaptateurs par channel_type│ │
                 │  └────────────────────────────────────────┘ │
                 │        │         │          │        │       │
                 │   whatsapp   whatsapp    telegram   email    │  ← adaptateurs
                 │   _baileys    _cloud      (bot)   (smtp/imap)│
                 │                                             │
                 │  Outbox webhooks (persistante, retry HMAC)  │
                 └──────────────┬──────────────────────────────┘
   App A  ◀── webhook signé ────┘   (message.received, .status_changed,
   App B  ◀── webhook signé ────┘    connection.connected/.disconnected)

   Back-office (frontend séparé)  ──▶  API admin (login + OTP)  ──▶  rs-connector
```

### 3.1 Abstraction « adaptateur de canal »

Chaque canal implémente une **interface commune** (le `session.js` Baileys actuel en est
déjà très proche : `connect` / `getState` / `sendMessage` + callbacks) :

```js
createXxxAdapter(deps, connection, options) => {
  connect(): Promise<void>
  disconnect(): Promise<void>
  getState(): { connected, status, auth? }   // auth: { qr } pour WhatsApp Baileys, etc.
  sendMessage({ to, content }): Promise<{ providerMessageId }>

  // Événements remontés via callbacks injectés (options) :
  //   onConnectionStateChange(state)
  //   onIncomingMessage({ from, providerMessageId, content, raw })
  //   onMessageStatusUpdate({ providerMessageId, status })

  capabilities: {
    auth: 'qr' | 'token' | 'oauth' | 'smtp_imap',
    inbound: boolean, outbound: boolean, statusReceipts: boolean
  }
}
```

- Le **Connection Manager** (généralisation de `session-manager`) est indexé par
  `connection_id`, lit le `channel_type` d'une connexion et instancie le bon adaptateur via
  un **registre**.
- La state-machine de statuts (`message-status.js`), l'outbox de webhooks
  (`webhook-dispatcher.js`) et la signature HMAC (`webhook-signer.js`) sont **déjà
  génériques** — ils changent surtout `boutique_id` → `connection_id`.
- Le `contact-resolver.js` (résolution LID→numéro) est **spécifique WhatsApp** : il devient
  un détail interne de l'adaptateur WhatsApp, pas du cœur.

### 3.2 Modèle multi-app

- Table `applications` : chaque app branchée a une **clé API** (stockée hashée), une **URL
  webhook** et un **secret HMAC** propres.
- Une **connexion** appartient à **une** application (`connections.application_id`).
- API d'entrée authentifiée par clé API (`Authorization: Bearer <api_key>`), scoping strict :
  une app ne voit et n'agit que sur ses propres connexions.

### 3.3 Back-office sécurisé

- **Frontend séparé** (SPA), communiquant avec une **API d'admin** exposée par rs-connector.
- Auth : **mot de passe** (hash argon2 ou bcrypt) → **OTP TOTP** (2FA) → session.
- Cookies **httpOnly + Secure + SameSite**, protection **CSRF**, **rate-limit + lockout** sur
  le login. Séparé de l'API d'entrée des apps (surfaces distinctes).

### 3.4 Sécurité des credentials

- Les secrets de canal (token bot Telegram, mot de passe SMTP/IMAP, token Meta, creds
  Baileys…) sont **chiffrés AES-256-GCM** avant stockage.
- La **clé de chiffrement** vient de l'environnement / d'un fichier secret (`~/.secrets`),
  **jamais** stockée en base. Rotation documentée.

---

## 4. Modèle de données cible

> Migration depuis le socle : `sessions`(clé `boutique_id`) → `connections`(clé
> `connection_id`) ; toutes les tables filles passent de `boutique_id` à `connection_id`.

```
applications
  id                UUID PK
  name              TEXT
  api_key_hash      TEXT           -- hash de la clé API (jamais en clair)
  api_key_prefix    TEXT           -- préfixe visible (identification)
  webhook_url       TEXT
  webhook_secret    TEXT           -- secret HMAC propre à l'app (chiffré)
  status            TEXT
  created_at, updated_at

connections                        -- ex-"sessions", généralisé multi-canal
  id                    TEXT PK    -- connection_id
  application_id        UUID FK -> applications(id)
  channel_type          TEXT       -- whatsapp_baileys | whatsapp_cloud | telegram | email | ...
  display_name          TEXT
  status                TEXT DEFAULT 'initializing'
  auth_state            JSONB      -- transient (ex. { qr } WhatsApp)
  config                JSONB      -- non sensible (ex. phone_number_id, imap host/port)
  credentials_encrypted BYTEA      -- secrets chiffrés AES-GCM (token, mot de passe...)
  webhook_url           TEXT       -- override ; sinon celui de l'application
  last_connected_at, updated_at, created_at

messages_status                    -- inchangé sauf connection_id
  id BIGSERIAL PK, connection_id FK, message_id TEXT, status TEXT, occurred_at

message_status_anomalies           -- inchangé sauf connection_id

contacts                           -- généralisation du cache LID WhatsApp
  connection_id FK, external_id TEXT, resolved_id TEXT, resolved_at
  PRIMARY KEY(connection_id, external_id)

outbox_webhooks                    -- + routage vers l'app propriétaire
  id BIGSERIAL PK, connection_id FK, application_id FK, event_type TEXT,
  payload JSONB, status, attempts, next_retry_at, last_error, timestamps

-- Back-office (Task 9)
admin_users        id, username, password_hash, totp_secret (chiffré), totp_enabled, ...
login_attempts     suivi rate-limit / lockout
```

---

## 5. Canaux — matrice & vagues

| Canal | channel_type | Techno | Auth | Difficulté | Vague |
|-------|--------------|--------|------|-----------|-------|
| WhatsApp (non off.) | `whatsapp_baileys` | Baileys | QR | socle | ✅ existant |
| WhatsApp (officiel) | `whatsapp_cloud` | Meta Cloud API | token+webhook | ★★★ | 2 |
| Telegram | `telegram` | Bot API | token | ★ | **1** |
| Email | `email` | SMTP + IMAP | user/pass | ★★ | **1** |
| Discord | `discord` | discord.js | bot token | ★★ | 3 |
| SMS | `sms` | Twilio / Vonage | api key | ★★ | 3 |
| Microsoft Teams | `teams` | Bot Framework + Graph | Azure AD | ★★★★ | 3 |
| Messenger / Instagram | `meta_messaging` | Meta Cloud API | token | ★★★ | 3 (option) |

---

## 6. Surface d'API (cible)

**API d'entrée (apps, clé API) — préfixe `/v1`**
- `POST /v1/messages` — envoi sortant `{ connection_id, to, content }`
- `GET  /v1/connections` — connexions de l'app appelante
- `GET  /v1/connections/:id` — état d'une connexion (statut, QR si applicable)

**Webhooks sortants (rs-connector → app)** — signés `X-Webhook-Signature` (HMAC)
- `message.received`, `message.status_changed`, `connection.connected`,
  `connection.disconnected`

**API d'admin (back-office, session + OTP) — préfixe `/admin`**
- `POST /admin/login`, `POST /admin/login/otp`, `POST /admin/logout`
- CRUD `applications` (génération de clé API), CRUD `connections`, QR/statut, logs/anomalies

---

## 7. Feuille de route (tâches)

**Vague 0 — Socle rs-connector**
- [x] T1 — Clone propre `wa-gateway-desklink` → `rs-connector` (sans node_modules/.env/auth), install, tests verts (102/102)
- [x] T2 — Renommage/config (package.json, config.js, docker-compose.yml, .env.example, identité service) → base `rs-connector`
- [x] T3 — Ce document (`PLAN-TACHES.md`)

**Vague 1 — Abstraction + multi-app + 2 canaux**
- [x] T4 — Abstraction adaptateur de canal + migration `boutique_id → connection_id` ; WhatsApp/Baileys = 1er adaptateur ; tests conservés
- [x] T5 — Multi-app : table `applications`, clés API, scoping, API d'entrée `/v1`
- [x] T6 — Adaptateur **Telegram** (Bot API)
- [x] T7 — Adaptateur **Email** (SMTP + IMAP)

**Vague 2 — WhatsApp officiel + back-office sécurisé**
- [x] T8 — Adaptateur **WhatsApp Cloud API** (Meta)
- [x] T9 — Backend auth admin : password (scrypt) + OTP TOTP + CSRF + rate-limit/lockout
- [x] T10 — Frontend séparé (login → OTP → dashboard connexions/apps/config)
- [x] T11 — Chiffrement AES-GCM des credentials au repos + durcissement

**Vague 3 — Doc & extensions**
- [x] T12 — Doc de branchement multi-app (README + guide d'intégration) + durcissement final
- [ ] (option) Discord, SMS, Teams, Messenger/Instagram

---

## 8. État d'avancement

- **2026-07-04** — T1 ✅ (clone + install + 102/102 tests verts), T2 ✅ (renommage complet,
  aucune référence fonctionnelle résiduelle, 102/102 verts), T3 ✅ (ce document), T4 ✅
  (migration `boutique_id → connection_id` sur tout le code + tests + schéma ; table
  `connections` + colonne `channel_type` ; registre d'adaptateurs `src/adapters/` avec
  WhatsApp/Baileys comme 1er adaptateur ; `connection-manager` générique ; 102/102 verts).
- **2026-07-04** — T5 ✅ (table `applications` + `connections.application_id` ; clés API
  générées et hachées en SHA-256, jamais stockées en clair ; middleware d'auth par clé API ;
  routes `/v1` — `POST /v1/messages`, `GET /v1/connections[/:id]` — avec **scoping strict**
  par application ; +16 tests → 118/118 verts). L'ancien `/api/send` non authentifié reste
  en place (legacy interne), à retirer au profit de `/v1` au durcissement (T11/T12).
- **2026-07-04** — T6 ✅ (adaptateur **Telegram** (Bot API) : `src/adapters/telegram.js` —
  auth par token/`getMe`, envoi `sendMessage`, entrant par long-polling `getUpdates` ;
  enregistré au registre ; le connection-manager résout désormais des **deps par canal**
  (`channelDepsByType`, Telegram = `fetch`) ; +7 tests → 125/125 verts).
- **2026-07-05** — T7 ✅ (adaptateur **Email** : `src/adapters/email.js` — SMTP envoi via un
  mailer injecté, IMAP réception par polling des non-lus — + glue prod `email-transports.js`
  (nodemailer/imapflow/mailparser) ; enregistré ; deps par canal `email` câblées ; +9 tests
  → 134/134 verts). **Vague 1 terminée (T1–T7).** Durcissement au passage : `express`
  4.21.2 → 4.22.2 + `npm audit fix` → **0 vulnérabilité**.
- **2026-07-05** — T8 ✅ (adaptateur **WhatsApp Cloud API (Meta)** : `whatsapp-cloud.js`
  (connect/validate Graph, `sendMessage`, `ingestWebhook` messages+statuts) + helpers
  `whatsapp-cloud-webhook.js` (signature HMAC `X-Hub-Signature-256`, challenge GET, parsing) ;
  routes `GET/POST /webhooks/whatsapp-cloud` ; routage entrant par `phone_number_id` via un
  index `channelRef` du connection-manager ; +14 tests → 148/148 verts). **4 canaux** au registre.
- **2026-07-05** — T9 ✅ (backend back-office sécurisé, **zéro dépendance** : mot de passe
  `scrypt` natif, **OTP TOTP RFC 6238** natif (vérifié par vecteur de test), sessions cookie
  httpOnly (token stocké en base par hash SHA-256), **CSRF** (jeton synchroniseur), rate-limit
  + **lockout** (5 échecs → 15 min). Tables `admin_users`/`admin_sessions`/`login_attempts` ;
  routes `/admin` (login → OTP → session, logout, me, totp/setup+enable) ; CLI
  `scripts/create-admin.js` ; +16 tests → 164/164 verts).
- **2026-07-05** — T11 ✅ (fait avant T10 : configurer des comptes = stocker des secrets →
  chiffrement d'emblée). Coffre `crypto-vault.js` **AES-256-GCM** (clé hors DB), colonne
  `connections.credentials_encrypted`, secret TOTP chiffré au repos ; **endpoints de
  provisioning** `/admin` (channels, applications avec clé révélée une fois, connexions avec
  credentials chiffrés — **fail-closed** sans clé) ; restauration déchiffrée au démarrage ;
  CLI `scripts/generate-key.js` ; +14 tests → 178/178 verts. **Backend rs-connector complet (T1–T9, T11).**
- Prochaine étape : **T10** (frontend séparé Vite+React : login → OTP → dashboard ; l'API admin de provisioning est déjà prête).

- **2026-07-05** — T10 ✅ (frontend séparé **Vite + React** dans `frontend/` : machine à états
  login → OTP → dashboard ; client API cookie+CSRF ; sections Applications (création + clé
  révélée une fois) et Connexions (création par canal avec credentials JSON) ; `vite build` OK).
- **2026-07-05** — T12 ✅ (`README.md` + `docs/INTEGRATION.md` : guide de branchement multi-app
  — clé API, envoi `/v1`, réception + vérification de signature webhook, credentials par canal,
  webhook Meta ; durcissement : suppression de `/api/send` legacy non authentifié, exigence
  documentée de `WHATSAPP_CLOUD_APP_SECRET`). **Projet rs-connector terminé : T1–T12, 178 tests verts, 0 vulnérabilité.**
- **2026-07-05** — Ajout de l'argument **`channel`** à `POST /v1/messages` : la connexion cible
  est sélectionnée par type de canal (une app = un jeton + une base URL pour tous ses canaux) ;
  `connection_id` reste optionnel pour lever une ambiguïté (plusieurs connexions du même canal),
  et tout est facultatif si l'app n'a qu'une seule connexion. +7 tests → **185 verts**.
- **2026-07-05** — **Tests réels** (vraie base Postgres isolée + vrais serveurs Telegram/WhatsApp) :
  Telegram validé bout-en-bout (entrant → webhook **signé vérifié**, sortant via `/v1` par `channel`) ;
  WhatsApp Baileys connecté + QR généré. **Bug trouvé & corrigé** : `upsertConnection` réécrasait
  `channel_type` au défaut à chaque MAJ de statut → `COALESCE($6, connections.channel_type)`.
  Ajout endpoint admin d'envoi de test (`POST /admin/connections/:id/send`). **Interface complétée** :
  QR rendu dans le dashboard (client-side), champs de credentials **par canal**, statuts en direct,
  envoi de test depuis l'UI. Proxy Vite `/admin` configurable (RS_CONNECTOR_BACKEND_PORT). **188 tests verts.**

## 9. Points ouverts (à trancher plus tard)

- Connexion **partageable** entre apps (aujourd'hui : 1 connexion = 1 app) — modèle à
  faire évoluer si besoin (table de liaison `application_connections`).
- Rotation de la clé de chiffrement AES-GCM (procédure + versioning des secrets).
- Choix framework frontend du back-office (aligné avec les autres projets).
- Support des médias (images, pièces jointes) par canal — au-delà du texte.
