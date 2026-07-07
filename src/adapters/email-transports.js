'use strict';

/**
 * Glue de PRODUCTION pour l'adaptateur Email (Task 7) : implémente les fabriques
 * `createMailer` (SMTP via nodemailer) et `createMailReceiver` (IMAP via imapflow +
 * extraction du corps via mailparser), au contrat attendu par adapters/email.js.
 *
 * Non couvert par les tests unitaires (nécessite un vrai serveur mail) — la logique de
 * l'adaptateur, elle, est testée avec des mocks. Les libs sont require()'d paresseusement
 * pour ne pas les charger tant qu'aucune connexion email n'est créée.
 */

/**
 * @param {{host,port,secure,user,pass,from?}} smtpConfig
 * @returns {{ verify(): Promise<boolean>, sendMail(msg): Promise<{messageId}> }}
 */
function createMailer(smtpConfig) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure !== false, // true par défaut (465) ; false pour STARTTLS (587)
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
  });
  return {
    verify: () => transporter.verify(),
    sendMail: (msg) => transporter.sendMail(msg),
  };
}

/**
 * @param {{host,port,secure,user,pass}} imapConfig
 * @returns {{ connect(): Promise, fetchUnseen(): Promise<Array>, close(): Promise }}
 */
function createMailReceiver(imapConfig) {
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');

  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port,
    secure: imapConfig.secure !== false,
    auth: { user: imapConfig.user, pass: imapConfig.pass },
    logger: false,
  });
  let connected = false;

  return {
    async connect() {
      await client.connect();
      connected = true;
    },
    async fetchUnseen() {
      if (!connected) return [];
      const out = [];
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ seen: false }, { uid: true });
        for (const uid of uids || []) {
          const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!msg) continue;
          let text = null;
          let from = null;
          let subject = null;
          try {
            const parsed = await simpleParser(msg.source);
            text = parsed.text || null;
            subject = parsed.subject || null;
            if (parsed.from && parsed.from.value && parsed.from.value[0]) {
              from = parsed.from.value[0].address || null;
            }
          } catch {
            /* parsing best-effort : on retombe sur l'enveloppe ci-dessous */
          }
          if (!from && msg.envelope && msg.envelope.from && msg.envelope.from[0]) {
            from = msg.envelope.from[0].address || null;
          }
          if (!subject && msg.envelope) subject = msg.envelope.subject || null;
          out.push({ messageId: String(uid), from, subject, text });
          // Marque comme lu pour ne pas retraiter au prochain passage.
          try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch { /* best effort */ }
        }
      } finally {
        lock.release();
      }
      return out;
    },
    async close() {
      try { await client.logout(); } catch { /* best effort */ }
      connected = false;
    },
  };
}

module.exports = { createMailer, createMailReceiver };
