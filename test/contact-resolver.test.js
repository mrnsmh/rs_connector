'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContactResolver, LidUnresolvedError } = require('../src/contact-resolver');

function buildMockFs(files = {}) {
  return {
    async readFile(path) {
      if (files[path] !== undefined) return files[path];
      throw new Error('ENOENT');
    },
  };
}

function buildMockDb(contacts = {}) {
  const store = new Map(Object.entries(contacts));
  return {
    async getContact(connectionId, lid) {
      const key = `${connectionId}:${lid}`;
      return store.has(key) ? { phone_number: store.get(key) } : null;
    },
    async upsertContact({ connectionId, lid, phoneNumber }) {
      store.set(`${connectionId}:${lid}`, phoneNumber);
    },
    _store: store,
  };
}

test('cas 1 : mapping LID connu (fichier) résout vers le vrai numéro (@s.whatsapp.net)', async () => {
  const fs = buildMockFs({
    '/data/auth/b1/lid-mapping-139642322083882_reverse.json': '"212604258663"',
  });
  const resolver = createContactResolver({ fs }, '/data/auth/b1');

  const jid = await resolver.resolve('139642322083882@lid');
  assert.equal(jid, '212604258663@s.whatsapp.net');
});

test('cas 1 (variante) : mapping LID connu en cache DB résout sans lire de fichier', async () => {
  const fs = buildMockFs({}); // aucun fichier — le cache DB doit suffire
  const db = buildMockDb({ 'b1:139642322083882': '212604258663' });
  const resolver = createContactResolver({ fs, db }, '/data/auth/b1', 'b1');

  const jid = await resolver.resolve('139642322083882@lid');
  assert.equal(jid, '212604258663@s.whatsapp.net');
});

test('CORRECTIF cas 2 : mapping LID inconnu lève LidUnresolvedError (plus de repli silencieux @lid)', async () => {
  const fs = buildMockFs({});
  const resolver = createContactResolver({ fs }, '/data/auth/b1');

  await assert.rejects(
    () => resolver.resolve('999999999999999@lid'),
    (err) => {
      assert.ok(err instanceof LidUnresolvedError);
      assert.equal(err.lid, '999999999999999');
      return true;
    },
  );
});

test('cas 3 : destinataire déjà un JID numéro valide -> passthrough', async () => {
  const fs = buildMockFs({});
  const resolver = createContactResolver({ fs }, '/data/auth/b1');

  const jid = await resolver.resolve('212604258663@s.whatsapp.net');
  assert.equal(jid, '212604258663@s.whatsapp.net');
});

test('cas 3 (variante) : numéro brut sans suffixe reçoit le suffixe standard', async () => {
  const fs = buildMockFs({});
  const resolver = createContactResolver({ fs }, '/data/auth/b1');

  const jid = await resolver.resolve('212604258663');
  assert.equal(jid, '212604258663@s.whatsapp.net');
});

test('JID de groupe (@g.us) est laissé inchangé (passthrough)', async () => {
  const fs = buildMockFs({});
  const resolver = createContactResolver({ fs }, '/data/auth/b1');

  const jid = await resolver.resolve('123456789-987654321@g.us');
  assert.equal(jid, '123456789-987654321@g.us');
});

test('mapping LID avec fichier JSON invalide lève aussi LidUnresolvedError (pas de repli)', async () => {
  const fs = buildMockFs({
    '/data/auth/b1/lid-mapping-139642322083882_reverse.json': 'NOT VALID JSON',
  });
  const resolver = createContactResolver({ fs }, '/data/auth/b1');

  await assert.rejects(
    () => resolver.resolve('139642322083882@lid'),
    LidUnresolvedError,
  );
});

test('deux résolveurs pour deux authDir/connexions différents ne se mélangent jamais', async () => {
  const fs = buildMockFs({
    '/data/auth/connexion-a/lid-mapping-111111111111111_reverse.json': '"111111111111"',
    '/data/auth/connexion-b/lid-mapping-111111111111111_reverse.json': '"222222222222"',
  });
  const resolverA = createContactResolver({ fs }, '/data/auth/connexion-a');
  const resolverB = createContactResolver({ fs }, '/data/auth/connexion-b');

  const jidA = await resolverA.resolve('111111111111111@lid');
  const jidB = await resolverB.resolve('111111111111111@lid');

  assert.equal(jidA, '111111111111@s.whatsapp.net');
  assert.equal(jidB, '222222222222@s.whatsapp.net');
});

test('CORRECTIF : une résolution réussie via fichier alimente le cache DB (learnMapping)', async () => {
  const fs = buildMockFs({
    '/data/auth/b1/lid-mapping-139642322083882_reverse.json': '"212604258663"',
  });
  const db = buildMockDb({});
  const resolver = createContactResolver({ fs, db }, '/data/auth/b1', 'b1');

  await resolver.resolve('139642322083882@lid');

  assert.equal(db._store.get('b1:139642322083882'), '212604258663');
});

test('CORRECTIF : learnMapping() peut être appelé directement (ex. depuis un message entrant)', async () => {
  const fs = buildMockFs({});
  const db = buildMockDb({});
  const resolver = createContactResolver({ fs, db }, '/data/auth/b1', 'b1');

  await resolver.learnMapping('139642322083882', '212604258663');
  const jid = await resolver.resolve('139642322083882@lid');

  assert.equal(jid, '212604258663@s.whatsapp.net');
});

test('un échec du cache DB (ex. connexion perdue) ne casse pas la résolution via fichier', async () => {
  const fs = buildMockFs({
    '/data/auth/b1/lid-mapping-139642322083882_reverse.json': '"212604258663"',
  });
  const db = {
    async getContact() { throw new Error('DB indisponible'); },
    async upsertContact() { throw new Error('DB indisponible'); },
  };
  const resolver = createContactResolver({ fs, db }, '/data/auth/b1', 'b1');

  const jid = await resolver.resolve('139642322083882@lid');
  assert.equal(jid, '212604258663@s.whatsapp.net');
});
