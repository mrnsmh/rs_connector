import { useState } from 'react';
import Logo from './Logo.jsx';

export default function Login({ onSubmit, error }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try { await onSubmit(username, password); } finally { setBusy(false); }
  }

  return (
    <form className="auth-card" onSubmit={submit}>
      <div className="auth-logo"><Logo size={46} /></div>
      <h1>RS-Connector</h1>
      <p className="sub">Console d'administration</p>
      <label htmlFor="u">Identifiant</label>
      <input id="u" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
      <label htmlFor="p">Mot de passe</label>
      <input id="p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      <button type="submit" disabled={busy || !username || !password}>Se connecter</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}
