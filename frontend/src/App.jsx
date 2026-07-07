import { useEffect, useState } from 'react';
import { api, setCsrf } from './api';
import Login from './components/Login.jsx';
import Otp from './components/Otp.jsx';
import Dashboard from './components/Dashboard.jsx';

export default function App() {
  const [phase, setPhase] = useState('loading'); // loading | login | otp | dashboard
  const [error, setError] = useState(null);

  // Au chargement : si une session valide (OTP vérifié) existe déjà, aller au dashboard.
  useEffect(() => {
    api.me().then((m) => { setCsrf(m.csrfToken); setPhase('dashboard'); }).catch(() => setPhase('login'));
  }, []);

  async function handleLogin(username, password) {
    setError(null);
    try {
      const r = await api.login(username, password);
      setCsrf(r.csrfToken);
      setPhase(r.otpRequired && !r.otpVerified ? 'otp' : 'dashboard');
    } catch (e) {
      setError(e.status === 429 ? 'Compte temporairement verrouillé (trop de tentatives).' : 'Identifiants invalides.');
    }
  }

  async function handleOtp(code) {
    setError(null);
    try {
      const r = await api.otp(code);
      setCsrf(r.csrfToken);
      setPhase('dashboard');
    } catch {
      setError('Code de vérification invalide.');
    }
  }

  async function handleLogout() {
    await api.logout().catch(() => {});
    setCsrf(null);
    setPhase('login');
  }

  if (phase === 'loading') return <div className="center">Chargement…</div>;
  if (phase === 'login') return <Login onSubmit={handleLogin} error={error} />;
  if (phase === 'otp') return <Otp onSubmit={handleOtp} error={error} />;
  return <Dashboard onLogout={handleLogout} />;
}
