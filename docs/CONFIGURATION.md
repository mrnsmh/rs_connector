# Configuration & déploiement

Toute la configuration de rs-connector passe par des **variables d'environnement**. En Docker,
elles sont lues depuis `.env` (copié depuis [`.env.example`](../.env.example)). rs-connector est un
service **autonome** : aucune de ces variables n'est partagée avec un autre service.

## Générer les secrets

```bash
# Clé de chiffrement AES-256-GCM des credentials (32 octets, base64)
node scripts/generate-key.js
# équivaut à :
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Secret HMAC de webhook (exemple)
node -e "console.log('whsec_' + require('crypto').randomBytes(24).toString('hex'))"
```

## Référence des variables

### Service

| Variable | Défaut | Obligatoire | Description |
|---|---|---|---|
| `PORT` | `3007` | non | Port HTTP interne exposé au conteneur. |
| `LOG_LEVEL` | `info` | non | Niveau pino : `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `AUTH_DIR` | `/data/auth` | non | Dossier des données d'auth de canal (sessions Baileys). Doit être un **volume persistant**. |
| `PUBLIC_BASE_URL` | *(vide)* | **prod** | URL publique du service (ex. `https://rs-connector.example.com`), affichée aux applications. Derrière un proxy, la détection automatique n'est pas fiable — **définissez-la**. |

### Base de données (PostgreSQL)

| Variable | Défaut | Description |
|---|---|---|
| `DB_HOST` | `localhost` | Hôte PostgreSQL (`db` en Docker Compose). |
| `DB_PORT` | `5432` | Port. |
| `DB_NAME` | `rs_connector` | Base **dédiée** à rs-connector. |
| `DB_USER` | `rs_connector` | Utilisateur. |
| `DB_PASSWORD` | *(vide)* | **À définir.** Mot de passe fort. |

### Chiffrement & webhooks

| Variable | Défaut | Description |
|---|---|---|
| `CREDENTIALS_ENCRYPTION_KEY` | *(vide)* | **Clé AES-256-GCM** (32 octets base64) chiffrant les credentials de canal au repos. **Vide ⇒ fail-closed** : impossible de créer une connexion avec secrets. À garder **hors base**. |
| `WEBHOOK_SECRET` | *(vide)* | Secret HMAC **de repli** pour signer les webhooks sortants quand une application n'a pas le sien. |
| `DEFAULT_WEBHOOK_URL` | *(vide)* | URL webhook de repli si une connexion/application n'en configure pas. |
| `V1_RATE_LIMIT_PER_MIN` | `240` | Anti-abus : nombre max de requêtes `/v1/messages` **par application et par minute**. `0` désactive. |

### WhatsApp Cloud API (Meta)

| Variable | Défaut | Description |
|---|---|---|
| `WHATSAPP_CLOUD_VERIFY_TOKEN` | *(vide)* | Chaîne libre recopiée dans la config du webhook côté Meta (validation `GET`). |
| `WHATSAPP_CLOUD_APP_SECRET` | *(vide)* | Secret de l'app Meta, pour vérifier `X-Hub-Signature-256` des `POST` entrants. |
| `WHATSAPP_CLOUD_GRAPH_VERSION` | `v21.0` | Version de l'API Graph. |

### Back-office (admin)

| Variable | Défaut | Description |
|---|---|---|
| `ADMIN_TOTP_ISSUER` | `rs-connector` | Libellé affiché dans l'app d'authentification TOTP. |
| `ADMIN_SESSION_TTL` | `43200` | Durée de vie d'une session (secondes ; 12 h par défaut). |
| `ADMIN_COOKIE_SECURE` | `true` | Flag `Secure` du cookie de session. Mettre `false` **uniquement** en dev HTTP local. |

## Checklist de production

- [ ] `CREDENTIALS_ENCRYPTION_KEY`, `DB_PASSWORD`, `WEBHOOK_SECRET` définis et gardés secrets.
- [ ] `PUBLIC_BASE_URL` renseignée (URL publique réelle).
- [ ] `ADMIN_COOKIE_SECURE=true` et service servi en **HTTPS** (reverse-proxy).
- [ ] `WHATSAPP_CLOUD_APP_SECRET` / `WHATSAPP_CLOUD_VERIFY_TOKEN` définis si vous utilisez WhatsApp Cloud.
- [ ] Volume persistant monté sur `AUTH_DIR` (sinon ré-appairage WhatsApp à chaque redémarrage).
- [ ] Sauvegardes régulières de la base PostgreSQL **et** du dossier `AUTH_DIR`.
- [ ] Premier compte admin créé (`scripts/create-admin.js`) et **2FA activée**.

## Reverse-proxy (exemple nginx)

Servez le back-office (`frontend/dist`) et l'API sous le **même domaine** pour que le cookie de
session (`SameSite=Strict` + `Secure`) fonctionne :

```nginx
server {
  server_name rs-connector.example.com;

  # API + back-office rs-connector
  location /v1/       { proxy_pass http://127.0.0.1:3007; }
  location /admin/    { proxy_pass http://127.0.0.1:3007; }
  location /webhooks/ { proxy_pass http://127.0.0.1:3007; }
  location /health    { proxy_pass http://127.0.0.1:3007; }

  # Front statique (dist du build Vite), en repli SPA
  location / {
    root /var/www/rs-connector-frontend;
    try_files $uri /index.html;
  }

  # Transmettez le protocole réel pour les cookies Secure derrière le proxy
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Host $host;
}
```

## Sauvegarde & restauration

- **Base** : `pg_dump`/`pg_restore` classiques sur la base `DB_NAME`.
- **Sessions de canal** : sauvegardez le dossier `AUTH_DIR` (contient l'auth WhatsApp Baileys).
  Sa perte impose de **re-scanner le QR** des connexions WhatsApp non officielles.
- **Clé de chiffrement** : conservez `CREDENTIALS_ENCRYPTION_KEY` en lieu sûr — sans elle, les
  credentials chiffrés en base sont **irrécupérables**.
