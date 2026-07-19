'use strict';

/**
 * Mailer système pour les emails transactionnels de rs-connector (vérification d'email des
 * comptes utilisateurs self-service). Réutilise le transport SMTP nodemailer d'adapters.
 * Retourne null si aucune config SMTP n'est fournie → la vérification est alors désactivée
 * (les comptes sont auto-vérifiés) : dégradation gracieuse, l'inscription n'est jamais bloquée.
 */

const { createMailer } = require('./adapters/email-transports');
const logger = require('./logger');

function createSystemMailer(smtpConfig) {
  if (!smtpConfig || !smtpConfig.host) return null;
  const transport = createMailer(smtpConfig);
  const from = smtpConfig.from || smtpConfig.user;

  async function sendVerification(to, link) {
    const subject = 'Confirmez votre adresse email — RS-Connector';
    const text = `Bienvenue sur RS-Connector.\n\nConfirmez votre adresse email en ouvrant ce lien :\n${link}\n\nCe lien expire dans 24 heures. Si vous n'êtes pas à l'origine de cette inscription, ignorez cet email.`;
    const html = `<!doctype html><html><body style="margin:0;background:#f4f7fb;font-family:Inter,Arial,sans-serif;color:#182135">
  <div style="max-width:480px;margin:32px auto;background:#fff;border:1px solid #dce2ea;border-radius:14px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#0891b2,#06b6d4);padding:22px 24px">
      <span style="color:#fff;font-weight:700;font-size:18px">RS-Connector</span>
    </div>
    <div style="padding:26px 24px">
      <h1 style="margin:0 0 10px;font-size:19px">Confirmez votre adresse email</h1>
      <p style="margin:0 0 18px;color:#3a4a5e;line-height:1.6">Bienvenue ! Cliquez sur le bouton ci-dessous pour activer votre compte RS-Connector.</p>
      <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#0891b2,#06b6d4);color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">Confirmer mon email</a>
      <p style="margin:20px 0 0;color:#64748b;font-size:12.5px;line-height:1.6">Ou copiez ce lien :<br><span style="word-break:break-all;color:#0891b2">${link}</span></p>
      <p style="margin:18px 0 0;color:#64748b;font-size:12.5px">Ce lien expire dans 24 heures. Si vous n'êtes pas à l'origine de cette inscription, ignorez cet email.</p>
    </div>
  </div>
</body></html>`;
    await transport.sendMail({ from, to, subject, text, html });
    logger.info({ to }, 'Email de vérification envoyé');
  }

  return { sendVerification, verify: () => transport.verify() };
}

module.exports = { createSystemMailer };
