'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createWebhookSigner } = require('../src/webhook-signer');

test('sign() produit une signature au format "sha256=<hex>"', () => {
  const signer = createWebhookSigner({ crypto });
  const signature = signer.sign({ event: 'message.received', text: 'hello' }, 'my-secret');

  assert.match(signature, /^sha256=[0-9a-f]{64}$/);
});

test('sign() est déterministe pour un même payload et secret', () => {
  const signer = createWebhookSigner({ crypto });
  const payload = { event: 'message.received', connectionId: 'b1' };

  const sig1 = signer.sign(payload, 'secret-1');
  const sig2 = signer.sign(payload, 'secret-1');

  assert.equal(sig1, sig2);
});

test('sign() produit des signatures différentes pour des secrets différents', () => {
  const signer = createWebhookSigner({ crypto });
  const payload = { event: 'message.received' };

  const sig1 = signer.sign(payload, 'secret-1');
  const sig2 = signer.sign(payload, 'secret-2');

  assert.notEqual(sig1, sig2);
});

test('sign() lève une erreur explicite si aucun secret n\'est fourni', () => {
  const signer = createWebhookSigner({ crypto });
  assert.throws(() => signer.sign({ event: 'x' }, ''), /Secret HMAC requis/);
});

test('verify() accepte une signature valide', () => {
  const signer = createWebhookSigner({ crypto });
  const payload = { event: 'message.received', connectionId: 'b1' };
  const signature = signer.sign(payload, 'my-secret');

  assert.equal(signer.verify(payload, 'my-secret', signature), true);
});

test('verify() rejette une signature invalide (payload altéré)', () => {
  const signer = createWebhookSigner({ crypto });
  const originalPayload = { event: 'message.received', connectionId: 'b1' };
  const signature = signer.sign(originalPayload, 'my-secret');

  const tamperedPayload = { event: 'message.received', connectionId: 'b2' };
  assert.equal(signer.verify(tamperedPayload, 'my-secret', signature), false);
});

test('verify() rejette une signature valide mais avec le mauvais secret', () => {
  const signer = createWebhookSigner({ crypto });
  const payload = { event: 'message.received' };
  const signature = signer.sign(payload, 'secret-correct');

  assert.equal(signer.verify(payload, 'secret-incorrect', signature), false);
});

test('verify() rejette une signature de longueur différente sans planter', () => {
  const signer = createWebhookSigner({ crypto });
  const payload = { event: 'x' };

  assert.equal(signer.verify(payload, 'secret', 'sha256=abc'), false);
});

test('verify() rejette une signature absente ou de mauvais type', () => {
  const signer = createWebhookSigner({ crypto });
  const payload = { event: 'x' };

  assert.equal(signer.verify(payload, 'secret', null), false);
  assert.equal(signer.verify(payload, 'secret', undefined), false);
  assert.equal(signer.verify(payload, 'secret', 12345), false);
});

test('sign()/verify() fonctionnent aussi avec un payload déjà sérialisé (string)', () => {
  const signer = createWebhookSigner({ crypto });
  const serialized = JSON.stringify({ event: 'message.received' });
  const signature = signer.sign(serialized, 'my-secret');

  assert.equal(signer.verify(serialized, 'my-secret', signature), true);
});
