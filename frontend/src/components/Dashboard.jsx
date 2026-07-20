import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import Logo from './Logo.jsx';

const CHANNEL_LABELS = {
  whatsapp_baileys: 'WhatsApp · Baileys (QR)',
  whatsapp_cloud: 'WhatsApp Cloud · Meta',
  telegram: 'Telegram',
  email: 'Email · SMTP/IMAP',
};
const label = (t) => CHANNEL_LABELS[t] || t;

// Construit l'objet credentials attendu par l'adaptateur, à partir de champs simples.
function buildCreds(channel, c) {
  if (channel === 'telegram') return c.token ? { token: c.token.trim() } : null;
  if (channel === 'whatsapp_cloud') {
    return c.token || c.phoneNumberId ? { token: (c.token || '').trim(), phoneNumberId: (c.phoneNumberId || '').trim() } : null;
  }
  if (channel === 'email') {
    const smtp = c.smtp || {}, imap = c.imap || {}, out = {};
    if (smtp.host) out.smtp = { ...smtp, port: Number(smtp.port) || undefined, secure: Number(smtp.port) === 465 };
    if (imap.host) out.imap = { ...imap, port: Number(imap.port) || undefined, secure: Number(imap.port) !== 143 };
    return Object.keys(out).length ? out : null;
  }
  return null; // whatsapp_baileys : appairage par QR
}

// ---- Champs de credentials par canal (fini le JSON brut) ----
function CredentialFields({ channel, value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  if (channel === 'telegram') {
    return (
      <label>Token du bot (@BotFather)
        <input value={value.token || ''} onChange={(e) => set({ token: e.target.value })} placeholder="123456:ABC-DEF..." />
      </label>
    );
  }
  if (channel === 'whatsapp_cloud') {
    return (
      <div className="row">
        <label>Token (Graph API)
          <input value={value.token || ''} onChange={(e) => set({ token: e.target.value })} placeholder="EAA..." />
        </label>
        <label>Phone Number ID
          <input value={value.phoneNumberId || ''} onChange={(e) => set({ phoneNumberId: e.target.value })} placeholder="123456789012345" />
        </label>
      </div>
    );
  }
  if (channel === 'email') {
    const smtp = value.smtp || {}, imap = value.imap || {};
    const setSmtp = (p) => set({ smtp: { ...smtp, ...p } });
    const setImap = (p) => set({ imap: { ...imap, ...p } });
    return (
      <div className="row">
        <div>
          <h4>SMTP (envoi)</h4>
          <label>Hôte<input value={smtp.host || ''} onChange={(e) => setSmtp({ host: e.target.value })} placeholder="smtp.exemple.com" /></label>
          <label>Port<input value={smtp.port || ''} onChange={(e) => setSmtp({ port: e.target.value })} placeholder="465" /></label>
          <label>Utilisateur<input value={smtp.user || ''} onChange={(e) => setSmtp({ user: e.target.value })} /></label>
          <label>Mot de passe<input type="password" value={smtp.pass || ''} onChange={(e) => setSmtp({ pass: e.target.value })} /></label>
        </div>
        <div>
          <h4>IMAP (réception · optionnel)</h4>
          <label>Hôte<input value={imap.host || ''} onChange={(e) => setImap({ host: e.target.value })} placeholder="imap.exemple.com" /></label>
          <label>Port<input value={imap.port || ''} onChange={(e) => setImap({ port: e.target.value })} placeholder="993" /></label>
          <label>Utilisateur<input value={imap.user || ''} onChange={(e) => setImap({ user: e.target.value })} /></label>
          <label>Mot de passe<input type="password" value={imap.pass || ''} onChange={(e) => setImap({ pass: e.target.value })} /></label>
        </div>
      </div>
    );
  }
  return <p className="muted">Aucun identifiant à saisir : l'appairage se fait par QR code après la création.</p>;
}

// ---- Vue QR (WhatsApp Baileys) : sonde l'état et rend le QR côté client ----
function QrView({ connectionId }) {
  const [state, setState] = useState(null);
  const [dataUrl, setDataUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const s = await api.connectionQr(connectionId);
        if (!alive) return;
        setState(s);
        if (s.qr && s.status !== 'connected') setDataUrl(await QRCode.toDataURL(s.qr, { width: 260, margin: 1 }));
        else setDataUrl(null);
      } catch { /* ignore transient */ }
    }
    tick();
    const iv = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [connectionId]);

  // Floating pill: add 'scrolled' class to header on scroll
  useEffect(() => {
    const header = document.querySelector('.topbar');
    if (!header) return;
    const onScroll = () => {
      header.classList.toggle('scrolled', window.scrollY > 10);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!state) return <p className="muted">Chargement de l'état…</p>;
  if (state.status === 'connected') return <p className="ok">✓ Appareil connecté</p>;
  if (dataUrl) {
    return (
      <div className="qrbox">
        <img src={dataUrl} alt="QR WhatsApp" />
        <p className="muted">WhatsApp → <b>Appareils connectés</b> → <b>Connecter un appareil</b>. Rafraîchi automatiquement.</p>
      </div>
    );
  }
  return <p className="muted">Statut : {state.status} — QR en attente…</p>;
}

// ---- Envoi de test depuis l'UI ----
function TestSend({ connectionId }) {
  const [to, setTo] = useState('');
  const [text, setText] = useState('Test rs-connector ✅');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  async function send(e) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await api.sendTest(connectionId, to, text);
      setMsg({ ok: true, text: `Envoyé (messageId : ${r.result && r.result.messageId ? r.result.messageId : 'ok'})` });
    } catch (err) {
      setMsg({ ok: false, text: err.data && err.data.error === 'connection_not_active' ? 'Connexion non active.' : (err.message || 'Échec') });
    } finally { setBusy(false); }
  }
  return (
    <form className="subform" onSubmit={send}>
      <div className="inline-row">
        <label>Destinataire<input value={to} onChange={(e) => setTo(e.target.value)} placeholder="chat_id / numéro / email" /></label>
        <label>Message<input value={text} onChange={(e) => setText(e.target.value)} /></label>
        <button type="submit" disabled={busy || !to || !text}>Envoyer</button>
      </div>
      {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}
    </form>
  );
}

// ---- Carte d'une connexion ----
function ConnectionCard({ c, onDelete, isDefault, canBeDefault, onToggleDefault, apps, onReassign }) {
  const [tab, setTab] = useState(null); // 'qr' | 'send' | null
  const status = (c.state && c.state.status) || c.status;
  const isBaileys = c.channelType === 'whatsapp_baileys';
  return (
    <div className={`card${isDefault ? ' is-default' : ''}`}>
      <div className="card-head">
        <span className="id">{c.connectionId}</span>
        <span className="badge">{label(c.channelType)}</span>
        {isDefault && <span className="badge is-default" title="Canal par défaut de l'application (utilisé quand l'appel ne précise pas de canal)">★ défaut</span>}
        <span className="spacer" />
        <span className={`status ${status}`}><span className="dot" />{status}</span>
      </div>
      <div className="actions-inline">
        {isBaileys && <button className="secondary" onClick={() => setTab(tab === 'qr' ? null : 'qr')}>{tab === 'qr' ? 'Masquer le QR' : 'Afficher le QR'}</button>}
        <button className="secondary" onClick={() => setTab(tab === 'send' ? null : 'send')}>{tab === 'send' ? 'Fermer' : 'Tester l\u2019envoi'}</button>
        {canBeDefault && (
          isDefault
            ? <button className="small" onClick={onToggleDefault} title="Retirer ce canal comme défaut">★ Par défaut</button>
            : <button className="secondary small" onClick={onToggleDefault} title="Utiliser ce canal quand l'appel /v1/messages ne précise pas de canal">Définir par défaut</button>
        )}
        <span className="spacer" />
        <button className="secondary small danger" onClick={onDelete}>Supprimer</button>
      </div>
      <div className="actions-inline">
        <label className="conn-app" title="Application propriétaire de cette connexion. La réassignation ne coupe pas la session (mise à jour base uniquement).">
          <span className="muted small">Application</span>
          <select value={c.applicationId || ''} onChange={(e) => onReassign(e.target.value)}>
            <option value="">— Aucune —</option>
            {(apps || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      </div>
      {tab === 'qr' && <QrView connectionId={c.connectionId} />}
      {tab === 'send' && <TestSend connectionId={c.connectionId} />}
    </div>
  );
}

// ---- Bouton copier ----
function CopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="secondary small" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); } catch { /* clipboard indispo */ }
    }}>{ok ? 'Copié ✓' : 'Copier'}</button>
  );
}

// ---- Activation de la 2FA (TOTP) ----
function TwoFactor() {
  const [step, setStep] = useState('idle'); // idle | setup | done
  const [otpUrl, setOtpUrl] = useState(null);
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState(null);
  async function start() {
    setMsg(null);
    try {
      const r = await api.totpSetup();
      setSecret(r.secret);
      setOtpUrl(await QRCode.toDataURL(r.otpauthUri, { width: 220, margin: 1 }));
      setStep('setup');
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function enable(e) {
    e.preventDefault(); setMsg(null);
    try {
      await api.totpEnable(code);
      setStep('done'); setMsg({ ok: true, text: '2FA activée. Elle sera demandée à la prochaine connexion.' });
    } catch (e2) { setMsg({ ok: false, text: e2.data && e2.data.error === 'invalid_otp' ? 'Code invalide.' : e2.message }); }
  }
  return (
    <section className="panel">
      <h2>Sécurité — 2FA (TOTP)</h2>
      {step === 'idle' && (<>
        <p className="muted">Ajoutez une vérification par code (Google Authenticator, etc.) à la connexion admin.</p>
        <button className="secondary small" onClick={start}>Configurer la 2FA</button>
      </>)}
      {step === 'setup' && (<>
        <p className="muted">1. Scannez ce QR avec votre application d'authentification (ou saisissez la clé) :</p>
        {otpUrl && <div className="qrbox"><img src={otpUrl} alt="QR 2FA" style={{ width: 220, height: 220 }} /></div>}
        <code className="key">{secret}</code>
        <form className="inline-row" onSubmit={enable} style={{ marginTop: 12 }}>
          <label>2. Code à 6 chiffres<input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
          <button type="submit" disabled={code.length < 6}>Activer</button>
        </form>
      </>)}
      {step === 'done' && <p className="ok">✓ 2FA activée</p>}
      {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}
    </section>
  );
}

// ---- Changement du mot de passe admin ----
function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState(null);
  async function submit(e) {
    e.preventDefault(); setMsg(null);
    if (next.length < 10) { setMsg({ ok: false, text: 'Le nouveau mot de passe doit faire au moins 10 caractères.' }); return; }
    if (next !== confirm) { setMsg({ ok: false, text: 'La confirmation ne correspond pas.' }); return; }
    try {
      await api.changePassword(current, next);
      setMsg({ ok: true, text: 'Mot de passe modifié avec succès.' });
      setCurrent(''); setNext(''); setConfirm('');
    } catch (e2) {
      const code = e2.data && e2.data.error;
      const text = code === 'invalid_current_password' ? 'Mot de passe actuel incorrect.'
        : code === 'weak_password' ? 'Nouveau mot de passe trop court (10 caractères minimum).'
        : e2.message;
      setMsg({ ok: false, text });
    }
  }
  return (
    <section className="panel">
      <h2>Sécurité — Mot de passe</h2>
      <form onSubmit={submit}>
        <label>Mot de passe actuel<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label>Nouveau mot de passe<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <label>Confirmer<input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        <button type="submit" disabled={!current || !next || !confirm} style={{ marginTop: 8 }}>Changer le mot de passe</button>
      </form>
      {msg && <div className={msg.ok ? 'notice' : 'error'}>{msg.text}</div>}
    </section>
  );
}

export default function Dashboard({ onLogout }) {
  const [channels, setChannels] = useState([]);
  const [apps, setApps] = useState([]);
  const [connections, setConnections] = useState([]);
  const [err, setErr] = useState(null);

  const [appName, setAppName] = useState('');
  const [appWebhook, setAppWebhook] = useState('');
  const [revealedKey, setRevealedKey] = useState(null);
  const [revealedFor, setRevealedFor] = useState(null);
  const [revealedSecret, setRevealedSecret] = useState(null);
  const [info, setInfo] = useState(null);
  const [meUser, setMeUser] = useState(null);
  const [exChannel, setExChannel] = useState('');
  const [exTo, setExTo] = useState('');
  const [exText, setExText] = useState('Bonjour depuis rs-connector');

  const [connId, setConnId] = useState('');
  const [connType, setConnType] = useState('');
  const [connApp, setConnApp] = useState('');
  const [connWebhook, setConnWebhook] = useState('');
  const [creds, setCreds] = useState({});
  const [connMsg, setConnMsg] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [c, a, cx, inf, m] = await Promise.all([api.channels(), api.listApplications(), api.listConnections(), api.info().catch(() => null), api.me().catch(() => null)]);
      setChannels(c.channels || []);
      setApps(a.applications || []);
      setConnections(cx.connexions || []);
      if (inf) setInfo(inf);
      if (m) setMeUser(m.username);
      setConnType((prev) => prev || (c.channels && c.channels[0] ? c.channels[0].channelType : ''));
      setExChannel((prev) => prev || (c.channels && c.channels[0] ? c.channels[0].channelType : ''));
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 6000); // statuts en direct
    return () => clearInterval(iv);
  }, [refresh]);

  async function createApp(e) {
    e.preventDefault();
    setErr(null); setRevealedKey(null);
    try {
      const r = await api.createApplication(appName, appWebhook || null);
      setRevealedKey(r.apiKey); setRevealedFor(r.name || appName); setRevealedSecret(r.webhookSecret || null);
      setAppName(''); setAppWebhook('');
      refresh();
    } catch (e2) { setErr(e2.message); }
  }

  async function regenerate(app) {
    if (!window.confirm(`Régénérer la clé de « ${app.name} » ? L'ancienne sera immédiatement révoquée.`)) return;
    setErr(null); setRevealedKey(null); setRevealedSecret(null);
    try {
      const r = await api.regenerateKey(app.id);
      setRevealedKey(r.apiKey); setRevealedFor(r.name || app.name);
      refresh();
    } catch (e2) { setErr(e2.message); }
  }

  async function rotateSecret(app) {
    if (!window.confirm(`Régénérer le secret webhook de « ${app.name} » ? L'ancien cessera de signer.`)) return;
    setErr(null); setRevealedKey(null); setRevealedSecret(null);
    try {
      const r = await api.rotateWebhookSecret(app.id);
      setRevealedSecret(r.webhookSecret); setRevealedFor(r.name || app.name);
      refresh();
    } catch (e2) { setErr(e2.message); }
  }

  async function delApp(app) {
    if (!window.confirm(`Supprimer l'application « ${app.name} » et TOUTES ses connexions ? Irréversible.`)) return;
    setErr(null);
    try { await api.deleteApplication(app.id); refresh(); } catch (e2) { setErr(e2.message); }
  }

  async function delConn(c) {
    if (!window.confirm(`Supprimer la connexion « ${c.connectionId} » ? Irréversible.`)) return;
    setErr(null);
    try { await api.deleteConnection(c.connectionId); refresh(); } catch (e2) { setErr(e2.message); }
  }

  // Canal par défaut par application (repli /v1/messages quand l'appel ne précise pas de canal).
  const defaultByApp = {};
  for (const a of apps) if (a.default_connection_id) defaultByApp[a.id] = a.default_connection_id;

  async function toggleDefault(c) {
    setErr(null);
    const isDef = !!c.applicationId && defaultByApp[c.applicationId] === c.connectionId;
    try {
      if (isDef) await api.unsetDefaultConnection(c.connectionId);
      else await api.setDefaultConnection(c.connectionId);
      refresh();
    } catch (e2) {
      setErr(e2.data && e2.data.error === 'no_application'
        ? 'Rattachez d’abord cette connexion à une application pour en faire le canal par défaut.'
        : e2.message);
    }
  }

  // Réassignation de l'application d'une connexion (mise à jour base uniquement, sans couper
  // la session live). applicationId vide => détache la connexion de toute application.
  async function reassignApp(c, applicationId) {
    setErr(null);
    try {
      await api.setConnectionApplication(c.connectionId, applicationId || null);
      refresh();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function createConn(e) {
    e.preventDefault();
    setErr(null); setConnMsg(null);
    try {
      const r = await api.createConnection({
        connectionId: connId,
        channelType: connType,
        applicationId: connApp || null,
        webhookUrl: connWebhook || null,
        credentials: buildCreds(connType, creds),
      });
      setConnMsg(`Connexion « ${r.connectionId} » créée (statut : ${r.state ? r.state.status : 'n/a'}).`);
      setConnId(''); setCreds({}); setConnWebhook('');
      refresh();
    } catch (e2) {
      setErr(e2.data && e2.data.error === 'encryption_not_configured'
        ? 'Chiffrement non configuré (CREDENTIALS_ENCRYPTION_KEY) : impossible de stocker des credentials.'
        : e2.message);
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="mark"><Logo size={30} /></span>
            <span className="word"><b>RS-Connector</b><span className="sub">Console d'administration</span></span>
          </div>
          <span className="spacer" />
          {meUser && <span className="who">Connecté : <b>{meUser}</b></span>}
          <button className="secondary" onClick={onLogout}>Déconnexion</button>
        </div>
      </header>
      <main className="dash">
        <div className="summary">
          <span>{apps.length} application{apps.length > 1 ? 's' : ''}</span>
          <span>{connections.length} connexion{connections.length > 1 ? 's' : ''}</span>
          <span className="ok-text">{connections.filter((x) => ((x.state && x.state.status) || x.status) === 'connected').length} connectée(s)</span>
        </div>
        {err && <div className="panel error">{err}</div>}

        {info && (
          <section className="panel">
            <h2>Endpoint d'intégration</h2>
            <p className="muted">URL de base {info.detected ? '(détectée automatiquement — définissez PUBLIC_BASE_URL en production derrière un proxy)' : '(configurée)'} :</p>
            <code className="key">{info.baseUrl}</code>
            <div className="table-wrap"><table style={{ marginTop: 12 }}>
              <tbody>
                <tr><td>Envoi de message</td><td><code>POST {info.endpoints.sendMessage}</code></td></tr>
                <tr><td>Lister les connexions</td><td><code>GET {info.endpoints.listConnections}</code></td></tr>
                <tr><td>Webhook WhatsApp Cloud</td><td><code>{info.endpoints.whatsappCloudWebhook}</code></td></tr>
                <tr><td>Authentification</td><td><code>{info.auth}</code></td></tr>
              </tbody>
            </table></div>
            <h3 style={{ margin: '16px 0 8px', fontSize: 14 }}>Exemple d'appel — arguments &amp; choix du canal</h3>
            <div className="row">
              <label>Canal
                <select value={exChannel} onChange={(e) => setExChannel(e.target.value)}>
                  {channels.map((c) => <option key={c.channelType} value={c.channelType}>{label(c.channelType)}</option>)}
                </select>
              </label>
              <label>Destinataire (to)<input value={exTo} onChange={(e) => setExTo(e.target.value)} placeholder="chat_id / numéro / email" /></label>
              <label>Message (text)<input value={exText} onChange={(e) => setExText(e.target.value)} /></label>
            </div>
            <code className="key">{`curl -X POST ${info.endpoints.sendMessage} \\\n  -H "Authorization: Bearer ${revealedKey || '<clé_API>'}" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ channel: exChannel || '<canal>', to: exTo || '<destinataire>', text: exText || '<message>' })}'`}</code>
            <p className="muted" style={{ marginTop: 10 }}>Si vous omettez <code className="mono">channel</code> (et <code className="mono">connection_id</code>), l'appel utilise le <b>canal par défaut</b> de l'application — définissable via le bouton « Définir par défaut » sur une connexion ci-dessous.</p>
          </section>
        )}

        <section className="panel">
          <h2>Applications</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Nom</th><th>Clé (préfixe)</th><th>Webhook</th><th>Statut</th><th></th></tr></thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td><span className="badge">{a.api_key_prefix}…</span></td>
                  <td className="muted">{a.webhook_url || '—'}</td>
                  <td>{a.status}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="secondary small" onClick={() => regenerate(a)}>Régénérer clé</button>{' '}
                    <button className="secondary small" onClick={() => rotateSecret(a)}>Secret webhook</button>{' '}
                    <button className="secondary small danger" onClick={() => delApp(a)}>Supprimer</button>
                  </td>
                </tr>
              ))}
              {apps.length === 0 && <tr><td colSpan={5} className="muted">Aucune application</td></tr>}
            </tbody>
          </table></div>
          <form className="row" onSubmit={createApp} style={{ marginTop: 16, alignItems: 'end' }}>
            <label>Nom de l'application<input value={appName} onChange={(e) => setAppName(e.target.value)} /></label>
            <label>Webhook URL (optionnel)<input value={appWebhook} onChange={(e) => setAppWebhook(e.target.value)} placeholder="https://mon-app/webhooks/rs-connector" /></label>
            <div style={{ flex: '0 0 auto' }}><button type="submit" disabled={!appName}>Créer</button></div>
          </form>
          {revealedKey && (
            <div className="notice">
              Clé API {revealedFor ? `de « ${revealedFor} »` : ''} (copiez-la maintenant, elle ne sera plus affichée) :
              <code className="key">{revealedKey}</code>
              <div style={{ marginTop: 8 }}><CopyBtn text={revealedKey} /></div>
              {info && <div className="muted" style={{ marginTop: 8 }}>Elle est déjà insérée dans l'« Exemple d'appel » du panneau Endpoint ci-dessus.</div>}
            </div>
          )}
          {revealedSecret && (
            <div className="notice">
              Secret webhook {revealedFor ? `de « ${revealedFor} »` : ''} — vérifie la signature X-Webhook-Signature des webhooks reçus :
              <code className="key">{revealedSecret}</code>
              <div style={{ marginTop: 8 }}><CopyBtn text={revealedSecret} /></div>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>Connexions</h2>
          <div className="cards">
            {connections.map((c) => (
              <ConnectionCard
                key={c.connectionId}
                c={c}
                onDelete={() => delConn(c)}
                canBeDefault={!!c.applicationId}
                isDefault={!!c.applicationId && defaultByApp[c.applicationId] === c.connectionId}
                onToggleDefault={() => toggleDefault(c)}
                apps={apps}
                onReassign={(appId) => reassignApp(c, appId)}
              />
            ))}
            {connections.length === 0 && <p className="muted">Aucune connexion pour le moment.</p>}
          </div>

          <form onSubmit={createConn} style={{ marginTop: 20 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Nouvelle connexion</h3>
            <div className="row">
              <label>Identifiant<input value={connId} onChange={(e) => setConnId(e.target.value)} placeholder="ex : boutique-a-telegram" /></label>
              <label>Canal
                <select value={connType} onChange={(e) => { setConnType(e.target.value); setCreds({}); }}>
                  {channels.map((c) => <option key={c.channelType} value={c.channelType}>{label(c.channelType)}</option>)}
                </select>
              </label>
              <label>Application
                <select value={connApp} onChange={(e) => setConnApp(e.target.value)}>
                  <option value="">— aucune —</option>
                  {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            </div>
            <label>Webhook URL (optionnel)<input value={connWebhook} onChange={(e) => setConnWebhook(e.target.value)} placeholder="hérite de l'application si vide" /></label>
            <div className="creds-block"><CredentialFields channel={connType} value={creds} onChange={setCreds} /></div>
            <button type="submit" disabled={!connId || !connType}>Créer la connexion</button>
          </form>
          {connMsg && <div className="notice">{connMsg}</div>}
        </section>

        <TwoFactor />
        <ChangePassword />
      </main>
    </>
  );
}
