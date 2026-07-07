# Brancher une application sur rs-connector

Ce guide explique comment une application tierce se branche sur rs-connector : obtenir une clé API,
configurer une connexion de canal, envoyer des messages, et recevoir les événements entrants
via des webhooks signés.

## Vue d'ensemble

```
  Votre application  ──(clé API)──▶  POST /v1/messages        (envoi sortant)
  Votre application  ◀──(webhook signé HMAC)──  message.received, message.status_changed, …
```

- **Sens sortant** : votre app appelle l'API `/v1` de rs-connector, authentifiée par **clé API**.
- **Sens entrant** : rs-connector appelle l'**URL webhook** de votre app, avec une **signature HMAC**
  que vous devez vérifier.

Une **connexion** représente un compte de canal (ex. « le WhatsApp de la boutique A », « le bot
Telegram support »). Une connexion appartient à **une** application.

---

## Étape 1 — Créer une application (back-office)

Dans le dashboard (`/admin`), section **Applications** → *Créer*. rs-connector génère une **clé API**
affichée **une seule fois** (elle n'est stockée que hachée). Conservez-la comme un secret.

Champs : `name`, `webhookUrl` (optionnel — l'URL de votre app qui recevra les événements).

> **Clé perdue ?** Bouton **« Régénérer la clé »** : une nouvelle clé est révélée une fois et
> l'ancienne est **immédiatement révoquée**. L'**URL de base** à appeler est affichée dans le
> panneau « Endpoint d'intégration » du dashboard (définissez `PUBLIC_BASE_URL` en production).

## Étape 2 — Créer une connexion de canal (back-office)

Section **Connexions** → *Créer* : `connectionId` (identifiant libre unique), `channelType`,
l'`application` propriétaire, `webhookUrl` (optionnel, sinon celui de l'application), et les
**credentials** du canal (chiffrés au repos). Formats attendus :

| `channelType` | `credentials` (JSON) |
|---|---|
| `telegram` | `{ "token": "123456:ABC-DEF..." }` |
| `whatsapp_cloud` | `{ "token": "EAA...", "phoneNumberId": "123456789" }` |
| `email` | `{ "smtp": {"host","port","secure","user","pass"}, "imap": {"host","port","secure","user","pass"} }` |
| `whatsapp_baileys` | *(aucun)* — l'appairage se fait par **QR** ; récupérez l'état via `GET /admin/connections/:id/qr` |

> ⚠️ La création d'une connexion **avec** credentials exige que `CREDENTIALS_ENCRYPTION_KEY` soit
> configurée côté serveur (sinon `400 encryption_not_configured`).

## Étape 3 — Envoyer un message

Indiquez le **canal** à utiliser via `channel` (le type de canal) : rs-connector choisit la connexion
de ce canal appartenant à votre application.

```bash
curl -X POST https://rs-connector.example.com/v1/messages \
  -H "Authorization: Bearer dk_votreCléAPI" \
  -H "Content-Type: application/json" \
  -d '{ "channel": "telegram", "to": "<destinataire>", "text": "Bonjour !" }'
```

- `channel` : `whatsapp_baileys`, `whatsapp_cloud`, `telegram` ou `email`.
- `to` : chat_id (Telegram), numéro (WhatsApp), adresse email (Email).
- **Sélection de la connexion** :
  - une **seule** connexion sur l'application → `channel` et `connection_id` sont **facultatifs** ;
  - **plusieurs** connexions → précisez `channel` ;
  - plusieurs connexions **du même canal** → ajoutez `connection_id` pour lever l'ambiguïté.
- Réponse : `200 { messageId, connectionId, channel, ... }`. Sinon, voir les codes d'erreur plus bas.

Lister vos connexions : `GET /v1/connections` (avec le header `Authorization: Bearer …`).

## Étape 4 — Recevoir les événements (webhooks)

rs-connector envoie un `POST` à l'`webhookUrl` configurée, pour chaque événement :

- `message.received` — `{ connectionId, from, messageId, text }`
- `message.status_changed` — `{ connectionId, messageId, status }`
- `session.connected` / `session.disconnected` — `{ connectionId, status }`

En-têtes : `X-Webhook-Event: <type>` et `X-Webhook-Signature: sha256=<hex>`.

### Vérifier la signature (obligatoire)

La signature est `HMAC-SHA256` du **corps brut** de la requête, avec le secret partagé
(`WEBHOOK_SECRET`, ou le secret propre à l'application), au format `sha256=<hex>`.

```js
const crypto = require('node:crypto');

function verifyRsConnectorWebhook(rawBody, signatureHeader, secret) {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Express : utilisez le corps BRUT pour la vérification.
app.post('/webhooks/rs-connector', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifyRsConnectorWebhook(req.body, req.get('X-Webhook-Signature'), process.env.RS_CONNECTOR_WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  const event = req.get('X-Webhook-Event');
  const payload = JSON.parse(req.body.toString('utf8'));
  // … traiter payload selon event …
  res.status(200).json({ received: true });
});
```

Répondez `2xx` rapidement. En cas d'échec (non-2xx / timeout), rs-connector **rejoue** l'événement
avec un backoff exponentiel (outbox persistante) jusqu'à un nombre max de tentatives.

---

## Cas particulier — WhatsApp Cloud API (Meta)

Pour ce canal, **Meta** pousse les messages entrants vers rs-connector (et non l'inverse) :

1. Côté rs-connector, configurez `WHATSAPP_CLOUD_VERIFY_TOKEN` et `WHATSAPP_CLOUD_APP_SECRET`.
2. Dans la console Meta, déclarez l'URL de webhook : `https://rs-connector.example.com/webhooks/whatsapp-cloud`
   et le *verify token* identique à `WHATSAPP_CLOUD_VERIFY_TOKEN`.
3. rs-connector valide le `GET` de vérification (renvoie le `hub.challenge`) puis vérifie la signature
   `X-Hub-Signature-256` de chaque `POST` (rejet `401` si invalide), et route chaque message vers
   la connexion dont le `phone_number_id` correspond.

Vos applications reçoivent ensuite ces messages comme n'importe quel `message.received`.

## Codes d'erreur (résumé)

| Code | Sens |
|---|---|
| `401 unauthorized` | Clé API absente/invalide (ou session admin absente) |
| `400 missing_fields` | `to` ou `text` manquant |
| `400 channel_required` | Plusieurs connexions : précisez `channel` (ou `connection_id`) |
| `400 ambiguous_connection` | Plusieurs connexions du même canal : précisez `connection_id` |
| `400 channel_mismatch` | Le `connection_id` fourni n'est pas du `channel` indiqué |
| `404 connection_not_found` | Connexion inconnue ou hors de votre application (scoping) |
| `409 connection_not_active` | Connexion existante mais pas encore connectée |
| `422 lid_unresolved` | WhatsApp : destinataire non résolu (envoi bloqué) |
| `400 encryption_not_configured` | Credentials fournis mais `CREDENTIALS_ENCRYPTION_KEY` absente |
