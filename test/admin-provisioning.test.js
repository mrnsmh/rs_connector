'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const supertest = require('supertest');
const createApp = require('../src/app');
const { createVault } = require('../src/crypto-vault');
const { hashPassword } = require('../src/admin/password');

const PASSWORD = 'good-password-123';
const KEY = crypto.randomBytes(32).toString('base64');
const adminCfg = { issuer: 'rs-connector', sessionTtlSeconds: 3600, cookieSecure: false };

function buildMockDb() {
  const users = new Map();
  const sessions = new Map();
  const attempts = new Map();
  const apps = [];
  const connections = new Map();
  let seq = 1;
  return {
    _connections: connections,
    _addUser({ username, password }) {
      const id = `u${seq++}`;
      users.set(id, { id, username, password_hash: hashPassword(password), totp_secret: null, totp_enabled: false });
      return users.get(id);
    },
    // auth
    async getAdminUserByUsername(u) { return [...users.values()].find((x) => x.username === u) || null; },
    async getAdminUserById(id) { return users.get(id) || null; },
    async setAdminTotp(id, { totpSecret, totpEnabled }) { const u = users.get(id); if (u) { u.totp_secret = totpSecret; u.totp_enabled = totpEnabled; } return u; },
    async updateAdminPassword(id, passwordHash) { const u = users.get(id); if (u) u.password_hash = passwordHash; return u ? { id } : null; },
    async createAdminSession(s) { sessions.set(s.tokenHash, { id: s.tokenHash, admin_user_id: s.adminUserId, csrf_token: s.csrfToken, otp_verified: s.otpVerified, expires_at: s.expiresAt }); return sessions.get(s.tokenHash); },
    async getAdminSession(h) { return sessions.get(h) || null; },
    async markAdminSessionOtpVerified(h) { const s = sessions.get(h); if (s) s.otp_verified = true; },
    async deleteAdminSession(h) { sessions.delete(h); },
    async getLoginAttempt(u) { return attempts.get(u) || null; },
    async recordFailedLogin(u, { failedCount, lockedUntil = null }) { attempts.set(u, { username: u, failed_count: failedCount, locked_until: lockedUntil }); },
    async resetLoginAttempts(u) { attempts.delete(u); },
    // provisioning
    async listApplications() { return apps.map((a) => ({ id: a.id, name: a.name, api_key_prefix: a.api_key_prefix, webhook_url: a.webhook_url, status: a.status, default_connection_id: a.default_connection_id ?? null })); },
    async createApplication({ name, apiKeyHash, apiKeyPrefix, webhookUrl = null }) {
      const a = { id: `app${apps.length + 1}`, name, api_key_hash: apiKeyHash, api_key_prefix: apiKeyPrefix, webhook_url: webhookUrl, status: 'active', default_connection_id: null };
      apps.push(a);
      return a;
    },
    async updateApplicationApiKey(id, { apiKeyHash, apiKeyPrefix }) {
      const a = apps.find((x) => x.id === id);
      if (!a) return null;
      a.api_key_hash = apiKeyHash; a.api_key_prefix = apiKeyPrefix;
      return a;
    },
    async deleteApplication(id) {
      const i = apps.findIndex((x) => x.id === id);
      if (i < 0) return false;
      apps.splice(i, 1);
      return true;
    },
    async deleteConnection(id) { return connections.delete(id); },
    async getConnection(id) { return connections.get(id) || null; },
    async getApplicationById(id) { return apps.find((x) => x.id === id) || null; },
    async setConnectionApplication(id, applicationId) { const c = connections.get(id); if (c) c.application_id = applicationId; return c || null; },
    async setApplicationDefaultConnection(id, connectionId) { const a = apps.find((x) => x.id === id); if (a) a.default_connection_id = connectionId; return a || null; },
    async updateApplicationWebhookSecret(id, { webhookSecret }) { const a = apps.find((x) => x.id === id); if (!a) return null; a.webhook_secret = webhookSecret; return a; },
    async listConnections() { return [...connections.values()]; },
    async upsertConnection(row) {
      const ex = connections.get(row.connectionId) || {};
      const merged = {
        connection_id: row.connectionId,
        channel_type: row.channelType || ex.channel_type || 'whatsapp_baileys',
        application_id: row.applicationId ?? ex.application_id ?? null,
        webhook_url: row.webhookUrl ?? ex.webhook_url ?? null,
        credentials_encrypted: row.credentialsEncrypted ?? ex.credentials_encrypted ?? null,
        status: row.status || ex.status || 'initializing',
      };
      connections.set(row.connectionId, merged);
      return merged;
    },
  };
}

function buildConnectionManager() {
  const created = [];
  return {
    created,
    async getOrCreate(connectionId, opts) {
      created.push({ connectionId, opts });
      return { connect: async () => {}, getState: () => ({ connected: false, status: 'connecting', channelType: opts.channelType }) };
    },
    get() { return null; },
    remove() {},
    getAllStates() { return {}; },
  };
}

async function loginAgent(app) {
  const agent = supertest.agent(app);
  const login = await agent.post('/admin/login').send({ username: 'admin', password: PASSWORD });
  return { agent, csrf: login.body.csrfToken };
}

test('GET /admin/channels liste les 4 canaux disponibles', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent } = await loginAgent(createApp({ db, admin: adminCfg }));
  const res = await agent.get('/admin/channels');
  assert.equal(res.status, 200);
  const types = res.body.channels.map((c) => c.channelType);
  for (const t of ['whatsapp_baileys', 'telegram', 'email', 'whatsapp_cloud']) assert.ok(types.includes(t), `manque ${t}`);
});

test('POST /admin/applications crée une app et révèle la clé une seule fois', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg }));
  const res = await agent.post('/admin/applications').set('X-CSRF-Token', csrf).send({ name: 'App A' });
  assert.equal(res.status, 201);
  assert.ok(res.body.apiKey.startsWith('dk_'));
  assert.ok(res.body.apiKeyPrefix);
  const list = await agent.get('/admin/applications');
  assert.equal(list.body.applications.length, 1);
  assert.equal(list.body.applications[0].apiKey, undefined); // clé jamais re-révélée
});

test('POST /admin/connections avec credentials mais SANS coffre → 400 (fail-closed)', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager() }));
  const res = await agent.post('/admin/connections').set('X-CSRF-Token', csrf).send({ connectionId: 'c1', channelType: 'telegram', credentials: { token: 'x' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'encryption_not_configured');
});

test('POST /admin/connections chiffre les credentials et démarre la connexion', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const cm = buildConnectionManager();
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: cm, vault: createVault(KEY) }));
  const res = await agent.post('/admin/connections').set('X-CSRF-Token', csrf).send({ connectionId: 'c1', channelType: 'telegram', credentials: { token: 'secret-token' } });
  assert.equal(res.status, 201);
  const stored = db._connections.get('c1');
  assert.ok(stored.credentials_encrypted.startsWith('gcm1.'), 'credentials doivent être chiffrés');
  assert.ok(!stored.credentials_encrypted.includes('secret-token'), 'le secret ne doit pas apparaître en clair');
  assert.equal(cm.created.length, 1);
  assert.equal(cm.created[0].opts.credentials.token, 'secret-token'); // clair passé en mémoire à l'adaptateur
});

test('POST /admin/connections refuse un channel_type inconnu → 400', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager(), vault: createVault(KEY) }));
  const res = await agent.post('/admin/connections').set('X-CSRF-Token', csrf).send({ connectionId: 'c1', channelType: 'canal_inconnu' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'unknown_channel_type');
});

test('le provisioning exige l\'authentification (401 sans session)', async () => {
  const res = await supertest(createApp({ db: buildMockDb(), admin: adminCfg })).get('/admin/applications');
  assert.equal(res.status, 401);
});

test('POST /admin/connections/:id/send envoie via la session live', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const sent = [];
  const cm = {
    async getOrCreate() { return { connect: async () => {}, getState: () => ({}) }; },
    get() { return { sendMessage: async (to, text) => { sent.push({ to, text }); return { to, messageId: 'm1' }; } }; },
    getAllStates() { return {}; },
  };
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: cm }));
  const res = await agent.post('/admin/connections/c1/send').set('X-CSRF-Token', csrf).send({ to: '123', text: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.messageId, 'm1');
  assert.equal(sent.length, 1);
});

test('POST /admin/connections/:id/send sans session live → 409', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager() }));
  const res = await agent.post('/admin/connections/cX/send').set('X-CSRF-Token', csrf).send({ to: '1', text: 'x' });
  assert.equal(res.status, 409);
});

test('POST /admin/connections/:id/send sans CSRF → 403', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager() }));
  const res = await agent.post('/admin/connections/c1/send').send({ to: '1', text: 'x' });
  assert.equal(res.status, 403);
});

test('POST /admin/applications/:id/regenerate-key régénère et révèle une nouvelle clé', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg }));
  const created = await agent.post('/admin/applications').set('X-CSRF-Token', csrf).send({ name: 'App A' });
  const res = await agent.post(`/admin/applications/${created.body.id}/regenerate-key`).set('X-CSRF-Token', csrf).send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.apiKey.startsWith('dk_'));
  assert.notEqual(res.body.apiKey, created.body.apiKey);
});

test('POST /admin/applications/:id/regenerate-key sur app inconnue → 404', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg }));
  const res = await agent.post('/admin/applications/inconnu/regenerate-key').set('X-CSRF-Token', csrf).send({});
  assert.equal(res.status, 404);
});

test('GET /admin/info expose l\'endpoint d\'envoi (PUBLIC_BASE_URL)', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent } = await loginAgent(createApp({ db, admin: adminCfg, publicBaseUrl: 'https://rs-connector.example.com/' }));
  const res = await agent.get('/admin/info');
  assert.equal(res.status, 200);
  assert.equal(res.body.baseUrl, 'https://rs-connector.example.com');
  assert.equal(res.body.endpoints.sendMessage, 'https://rs-connector.example.com/v1/messages');
  assert.equal(res.body.detected, false);
});

test('DELETE /admin/connections/:id supprime la connexion', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const cm = buildConnectionManager();
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: cm, vault: createVault(KEY) }));
  await agent.post('/admin/connections').set('X-CSRF-Token', csrf).send({ connectionId: 'c1', channelType: 'telegram', credentials: { token: 'x' } });
  const res = await agent.delete('/admin/connections/c1').set('X-CSRF-Token', csrf);
  assert.equal(res.status, 200);
  assert.equal(db._connections.has('c1'), false);
});

test('DELETE /admin/applications/:id supprime l\'application', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager() }));
  const created = await agent.post('/admin/applications').set('X-CSRF-Token', csrf).send({ name: 'A' });
  const res = await agent.delete(`/admin/applications/${created.body.id}`).set('X-CSRF-Token', csrf);
  assert.equal(res.status, 200);
});

test('DELETE /admin/applications/:id inconnue → 404', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager() }));
  const res = await agent.delete('/admin/applications/nope').set('X-CSRF-Token', csrf);
  assert.equal(res.status, 404);
});

test('POST /admin/applications révèle aussi un secret webhook', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg }));
  const res = await agent.post('/admin/applications').set('X-CSRF-Token', csrf).send({ name: 'A' });
  assert.equal(res.status, 201);
  assert.ok(res.body.webhookSecret.startsWith('whsec_'));
});

test('POST /admin/applications/:id/rotate-webhook-secret régénère le secret', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg }));
  const created = await agent.post('/admin/applications').set('X-CSRF-Token', csrf).send({ name: 'A' });
  const res = await agent.post(`/admin/applications/${created.body.id}/rotate-webhook-secret`).set('X-CSRF-Token', csrf).send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.webhookSecret.startsWith('whsec_'));
  assert.notEqual(res.body.webhookSecret, created.body.webhookSecret);
});

test('POST /admin/change-password change le mot de passe (ancien KO, nouveau OK ensuite)', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg }));
  const res = await agent.post('/admin/change-password').set('X-CSRF-Token', csrf).send({ currentPassword: PASSWORD, newPassword: 'nouveau-mdp-123' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const relogOld = await supertest(createApp({ db, admin: adminCfg })).post('/admin/login').send({ username: 'admin', password: PASSWORD });
  assert.equal(relogOld.status, 401);
  const relogNew = await supertest(createApp({ db, admin: adminCfg })).post('/admin/login').send({ username: 'admin', password: 'nouveau-mdp-123' });
  assert.equal(relogNew.status, 200);
});

test('POST /admin/change-password avec mauvais mot de passe actuel → 401', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg }));
  const res = await agent.post('/admin/change-password').set('X-CSRF-Token', csrf).send({ currentPassword: 'faux-mdp', newPassword: 'nouveau-mdp-123' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_current_password');
});

test('POST /admin/change-password refuse un nouveau mot de passe trop court → 400', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg }));
  const res = await agent.post('/admin/change-password').set('X-CSRF-Token', csrf).send({ currentPassword: PASSWORD, newPassword: 'court' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'weak_password');
});

test('POST /admin/change-password sans CSRF → 403', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent } = await loginAgent(createApp({ db, admin: adminCfg }));
  const res = await agent.post('/admin/change-password').send({ currentPassword: PASSWORD, newPassword: 'nouveau-mdp-123' });
  assert.equal(res.status, 403);
});

test('POST /admin/change-password sans session → 401', async () => {
  const res = await supertest(createApp({ db: buildMockDb(), admin: adminCfg })).post('/admin/change-password').send({ currentPassword: 'x', newPassword: 'nouveau-mdp-123' });
  assert.equal(res.status, 401);
});

// ---- Canal par défaut (repli /v1/messages) ----

async function appWithConn(agent, csrf, vaultKey) {
  const app = await agent.post('/admin/applications').set('X-CSRF-Token', csrf).send({ name: 'A' });
  await agent.post('/admin/connections').set('X-CSRF-Token', csrf)
    .send({ connectionId: 'c1', channelType: 'telegram', applicationId: app.body.id, credentials: { token: 'x' } });
  return app.body.id;
}

test('POST /admin/connections/:id/default définit le canal par défaut de son application', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager(), vault: createVault(KEY) }));
  const appId = await appWithConn(agent, csrf);
  const res = await agent.post('/admin/connections/c1/default').set('X-CSRF-Token', csrf).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.defaultConnectionId, 'c1');
  assert.equal(res.body.applicationId, appId);
  const list = await agent.get('/admin/applications');
  assert.equal(list.body.applications.find((x) => x.id === appId).default_connection_id, 'c1');
});

test('DELETE /admin/connections/:id/default retire le canal par défaut', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager(), vault: createVault(KEY) }));
  const appId = await appWithConn(agent, csrf);
  await agent.post('/admin/connections/c1/default').set('X-CSRF-Token', csrf).send({});
  const res = await agent.delete('/admin/connections/c1/default').set('X-CSRF-Token', csrf);
  assert.equal(res.status, 200);
  const list = await agent.get('/admin/applications');
  assert.equal(list.body.applications.find((x) => x.id === appId).default_connection_id, null);
});

test('POST /admin/connections/:id/default sur connexion sans application → 400 no_application', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager(), vault: createVault(KEY) }));
  await agent.post('/admin/connections').set('X-CSRF-Token', csrf).send({ connectionId: 'orphan', channelType: 'telegram', credentials: { token: 'x' } });
  const res = await agent.post('/admin/connections/orphan/default').set('X-CSRF-Token', csrf).send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'no_application');
});

test('POST /admin/connections/:id/default sur connexion inconnue → 404', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager() }));
  const res = await agent.post('/admin/connections/nope/default').set('X-CSRF-Token', csrf).send({});
  assert.equal(res.status, 404);
});

test('POST /admin/connections/:id/default sans CSRF → 403', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager(), vault: createVault(KEY) }));
  await appWithConn(agent, csrf);
  const res = await agent.post('/admin/connections/c1/default').send({});
  assert.equal(res.status, 403);
});

// ---- Réassignation de l'application d'une connexion (DB-only, sans couper la session) ----

test('POST /admin/connections/:id/application réassigne la connexion à une autre application', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager(), vault: createVault(KEY) }));
  const app1 = await appWithConn(agent, csrf);
  const app2 = (await agent.post('/admin/applications').set('X-CSRF-Token', csrf).send({ name: 'B' })).body.id;
  const res = await agent.post('/admin/connections/c1/application').set('X-CSRF-Token', csrf).send({ applicationId: app2 });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.applicationId, app2);
  const list = await agent.get('/admin/connections');
  assert.equal(list.body.connexions.find((x) => x.connectionId === 'c1').applicationId, app2);
});

test('POST /admin/connections/:id/application avec applicationId vide détache la connexion', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager(), vault: createVault(KEY) }));
  await appWithConn(agent, csrf);
  const res = await agent.post('/admin/connections/c1/application').set('X-CSRF-Token', csrf).send({ applicationId: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.applicationId, null);
});

test('POST /admin/connections/:id/application sur connexion inconnue → 404 connection_not_found', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager() }));
  const res = await agent.post('/admin/connections/nope/application').set('X-CSRF-Token', csrf).send({ applicationId: 'app1' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'connection_not_found');
});

test('POST /admin/connections/:id/application avec application inconnue → 404 application_not_found', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager(), vault: createVault(KEY) }));
  await appWithConn(agent, csrf);
  const res = await agent.post('/admin/connections/c1/application').set('X-CSRF-Token', csrf).send({ applicationId: 'does-not-exist' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'application_not_found');
});

test('POST /admin/connections/:id/application ne touche PAS la session live (pitfall #1)', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  // connectionManager qui échoue si on tente de recréer/interroger/couper une session :
  // l'endpoint de réassignation ne doit faire qu'un UPDATE en base.
  const cm = {
    async getOrCreate() { throw new Error('getOrCreate interdit lors d’une réassignation'); },
    get() { throw new Error('get interdit'); },
    remove() { throw new Error('remove interdit'); },
    getAllStates() { return {}; },
  };
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: cm, vault: createVault(KEY) }));
  const app1 = (await agent.post('/admin/applications').set('X-CSRF-Token', csrf).send({ name: 'A' })).body.id;
  const app2 = (await agent.post('/admin/applications').set('X-CSRF-Token', csrf).send({ name: 'B' })).body.id;
  // Connexion pré-existante seedée directement (sans passer par POST /connections qui, lui,
  // démarre une session via le connectionManager).
  db._connections.set('c1', { connection_id: 'c1', channel_type: 'telegram', application_id: app1, status: 'connected' });
  const res = await agent.post('/admin/connections/c1/application').set('X-CSRF-Token', csrf).send({ applicationId: app2 });
  assert.equal(res.status, 200);
  assert.equal(res.body.applicationId, app2);
});

test('POST /admin/connections/:id/application sans CSRF → 403', async () => {
  const db = buildMockDb();
  db._addUser({ username: 'admin', password: PASSWORD });
  const { agent, csrf } = await loginAgent(createApp({ db, admin: adminCfg, connectionManager: buildConnectionManager(), vault: createVault(KEY) }));
  await appWithConn(agent, csrf);
  const res = await agent.post('/admin/connections/c1/application').send({ applicationId: 'x' });
  assert.equal(res.status, 403);
});
