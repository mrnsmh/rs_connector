'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidTransition,
  transition,
  fromBaileysStatusCode,
  ALL_STATUSES,
} = require('../src/message-status');

test('transitions valides acceptées : sent -> delivered -> read', () => {
  assert.equal(transition('sent', 'delivered'), 'delivered');
  assert.equal(transition('delivered', 'read'), 'read');
});

test('sent -> read directement est valide (WhatsApp peut regrouper les accusés)', () => {
  assert.equal(transition('sent', 'read'), 'read');
});

test('premier statut d\'un message (current=null) est toujours accepté', () => {
  assert.equal(transition(null, 'sent'), 'sent');
});

test('transition invalide read -> sent est rejetée explicitement', () => {
  assert.throws(() => transition('read', 'sent'), /Transition invalide/);
});

test('transition invalide delivered -> sent est rejetée explicitement', () => {
  assert.throws(() => transition('delivered', 'sent'), /Transition invalide/);
});

test('statut inconnu est rejeté explicitement', () => {
  assert.throws(() => transition('sent', 'bogus'), /Statut inconnu/);
});

test('branche failed -> retry -> sent fonctionne', () => {
  assert.equal(transition('sent', 'failed'), 'failed');
  assert.equal(transition('failed', 'retry'), 'retry');
  assert.equal(transition('retry', 'sent'), 'sent');
});

test('failed -> delivered est rejeté (doit repasser par retry)', () => {
  assert.throws(() => transition('failed', 'delivered'), /Transition invalide/);
});

test('read est un état terminal : aucune transition sortante valide', () => {
  for (const status of ALL_STATUSES) {
    assert.equal(isValidTransition('read', status), false);
  }
});

test('parsing des codes de statut Baileys (WAMessageStatus)', () => {
  assert.equal(fromBaileysStatusCode(0), 'failed'); // ERROR
  assert.equal(fromBaileysStatusCode(2), 'sent'); // SERVER_ACK
  assert.equal(fromBaileysStatusCode(3), 'delivered'); // DELIVERY_ACK
  assert.equal(fromBaileysStatusCode(4), 'read'); // READ
  assert.equal(fromBaileysStatusCode(5), 'read'); // PLAYED
  assert.equal(fromBaileysStatusCode(1), null); // PENDING, non pertinent ici
  assert.equal(fromBaileysStatusCode(999), null); // code inconnu
});
