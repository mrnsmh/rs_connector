// Client de l'API d'administration rs-connector. La session est portée par un cookie httpOnly
// (credentials: 'include') ; les mutations envoient le jeton CSRF renvoyé au login/OTP.

const BASE = '/admin';
let csrfToken = null;

export function setCsrf(token) {
  csrfToken = token || null;
}

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(BASE + path, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* réponse sans corps JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  login: (username, password) => request('/login', { method: 'POST', body: { username, password } }),
  otp: (code) => request('/login/otp', { method: 'POST', body: { code } }),
  logout: () => request('/logout', { method: 'POST' }),
  me: () => request('/me'),
  channels: () => request('/channels'),
  listApplications: () => request('/applications'),
  createApplication: (name, webhookUrl) => request('/applications', { method: 'POST', body: { name, webhookUrl } }),
  listConnections: () => request('/connections'),
  createConnection: (payload) => request('/connections', { method: 'POST', body: payload }),
  connectionQr: (id) => request(`/connections/${encodeURIComponent(id)}/qr`),
  sendTest: (id, to, text) => request(`/connections/${encodeURIComponent(id)}/send`, { method: 'POST', body: { to, text } }),
  regenerateKey: (id) => request(`/applications/${encodeURIComponent(id)}/regenerate-key`, { method: 'POST', body: {} }),
  info: () => request('/info'),
  totpSetup: () => request('/totp/setup', { method: 'POST', body: {} }),
  totpEnable: (code) => request('/totp/enable', { method: 'POST', body: { code } }),
  changePassword: (currentPassword, newPassword) => request('/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
  deleteConnection: (id) => request(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  deleteApplication: (id) => request(`/applications/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  rotateWebhookSecret: (id) => request(`/applications/${encodeURIComponent(id)}/rotate-webhook-secret`, { method: 'POST', body: {} }),
  setDefaultConnection: (id) => request(`/connections/${encodeURIComponent(id)}/default`, { method: 'POST', body: {} }),
  unsetDefaultConnection: (id) => request(`/connections/${encodeURIComponent(id)}/default`, { method: 'DELETE' }),
  setConnectionApplication: (id, applicationId) => request(`/connections/${encodeURIComponent(id)}/application`, { method: 'POST', body: { applicationId: applicationId || null } }),
};
