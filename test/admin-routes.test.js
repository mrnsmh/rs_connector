'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const createApp = require('../src/app');
const { hashPassword } = require('../src/admin/password');
const { generateSecret, generateTotp } = require('../src/admin/totp');

// Mock db en mémoire pour les tables admin (admin_users, admin_sessions, login_attempts).
function buildMockDb() {
  const users = new Map();
  const sessions = new Map();
  const attempts = new Map();
  let seq = 1;
  return {
    _addUser({ username, password, totpSecret = null, totpEnabled = false }) {
      const id = `u${seq++}`;
      users.set(id, { id, username, password_hash: hashPassword(password), totp_secret: totpSecret, totp_enabled: totpEnabled });
      return users.get(id);
    },
    async getAdminUserByUsername(username) {
      return [...users.values()].find((u) => u.username === username) || null;
    },
    async getAdminUserById(id) { return users.get(id) || null; },
    async setAdminTotp(id, { totpSecret, totpEnabled }) {
      const u = users.get(id);
      if (u) { u.totp_secret = totpSecret; u.totp_enabled = totpEnabled; }
      return u;
    },
    async createAdminSession({ tokenHash, adminUserId, csrfToken, otpVerified, expiresAt }) {
      const s = { id: tokenHash, admin_user_id: adminUserId, csrf_token: csrfToken, otp_verified: otpVerified, expires_at: expiresAt };
      sessions.set(tokenHash, s);
      return s;
    },
    async getAdminSession(tokenHash) { return sessions.get(tokenHash) || null; },
    async markAdminSessionOtpVerified(tokenHash) { const s = sessions.get(tokenHash); if (s) s.otp_verified = true; },
    async deleteAdminSession(tokenHash) { sessions.delete(tokenHash); },
    async getLoginAttempt(username) { return attempts.get(username) || null; },
    async recordFailedLogin(username, { failedCount, lockedUntil = null }) {
      attempts.set(username, { username, failed_count: failedCount, locked_until: lockedUntil });
    },
    async resetLoginAttempts(username) { attempts.delete(username); },
  };
}

const adminCfg = { issuer: 'rs-connector', sessionTtlSeconds: 3600, cookieSecure: false };

test('login : mauvais mot de passe → 401, puis lockout (429) après 5 échecs', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: 'good-pass' });
  const app = createApp({ db, admin: adminCfg });
  for (let i = 0; i < 5; i += 1) {
    const r = await supertest(app).post('/admin/login').send({ username: 'admin', password: 'wrong' });
    assert.equal(r.status, 401);
  }
  const locked = await supertest(app).post('/admin/login').send({ username: 'admin', password: 'good-pass' });
  assert.equal(locked.status, 429);
});

test('login sans 2FA → session complète, /me accessible', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: 'good-pass' });
  const agent = supertest.agent(createApp({ db, admin: adminCfg }));
  const login = await agent.post('/admin/login').send({ username: 'admin', password: 'good-pass' });
  assert.equal(login.status, 200);
  assert.equal(login.body.otpRequired, false);
  assert.ok(login.body.csrfToken);
  const me = await agent.get('/admin/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.username, 'admin');
});

test('login avec 2FA → /me refusé (403) avant OTP, autorisé après OTP correct', async () => {
  const db = buildMockDb();
  const secret = generateSecret();
  db._addUser({ username: 'admin', password: 'good-pass', totpSecret: secret, totpEnabled: true });
  const agent = supertest.agent(createApp({ db, admin: adminCfg }));

  const login = await agent.post('/admin/login').send({ username: 'admin', password: 'good-pass' });
  assert.equal(login.body.otpRequired, true);
  assert.equal(login.body.otpVerified, false);

  const before = await agent.get('/admin/me');
  assert.equal(before.status, 403);

  const bad = await agent.post('/admin/login/otp').send({ code: '000000' });
  assert.equal(bad.status, 401);

  const otp = await agent.post('/admin/login/otp').send({ code: generateTotp(secret) });
  assert.equal(otp.status, 200);

  const me = await agent.get('/admin/me');
  assert.equal(me.status, 200);
});

test('CSRF : mutation protégée refusée sans X-CSRF-Token, acceptée avec', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: 'good-pass' });
  const agent = supertest.agent(createApp({ db, admin: adminCfg }));
  const login = await agent.post('/admin/login').send({ username: 'admin', password: 'good-pass' });

  const noCsrf = await agent.post('/admin/totp/setup').send({});
  assert.equal(noCsrf.status, 403);

  const withCsrf = await agent.post('/admin/totp/setup').set('X-CSRF-Token', login.body.csrfToken).send({});
  assert.equal(withCsrf.status, 200);
  assert.ok(withCsrf.body.secret);
  assert.ok(withCsrf.body.otpauthUri.startsWith('otpauth://totp/'));
});

test('totp/enable active la 2FA après un code valide', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: 'good-pass' });
  const agent = supertest.agent(createApp({ db, admin: adminCfg }));
  const login = await agent.post('/admin/login').send({ username: 'admin', password: 'good-pass' });
  const csrf = login.body.csrfToken;

  const setup = await agent.post('/admin/totp/setup').set('X-CSRF-Token', csrf).send({});
  const enable = await agent.post('/admin/totp/enable').set('X-CSRF-Token', csrf).send({ code: generateTotp(setup.body.secret) });
  assert.equal(enable.status, 200);

  const me = await agent.get('/admin/me');
  assert.equal(me.body.totpEnabled, true);
});

test('logout invalide la session', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: 'good-pass' });
  const agent = supertest.agent(createApp({ db, admin: adminCfg }));
  await agent.post('/admin/login').send({ username: 'admin', password: 'good-pass' });
  await agent.post('/admin/logout').send({});
  const me = await agent.get('/admin/me');
  assert.equal(me.status, 401);
});

test('sans session, /me → 401', async () => {
  const app = createApp({ db: buildMockDb(), admin: adminCfg });
  const res = await supertest(app).get('/admin/me');
  assert.equal(res.status, 401);
});
