import { useState } from 'react';
import Logo from './Logo.jsx';

export default function Otp({ onSubmit, error }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try { await onSubmit(code); } finally { setBusy(false); }
  }

  return (
    <form className="auth-card" onSubmit={submit}>
      <div className="auth-logo"><Logo size={46} /></div>
      <h1>Vérification en deux étapes</h1>
      <p className="sub">Saisissez le code à 6 chiffres de votre application d'authentification.</p>
      <label htmlFor="c">Code OTP</label>
      <input
        id="c"
        inputMode="numeric"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        autoFocus
      />
      <button type="submit" disabled={busy || code.length < 6}>Vérifier</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}
