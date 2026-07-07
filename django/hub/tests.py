"""Tests du coffre AES-256-GCM (parite avec test/crypto-vault.test.js cote Node)."""
import base64
import os

from django.test import SimpleTestCase

from hub.crypto_vault import PREFIX, Vault, VaultError, generate_key

KEY = base64.b64encode(os.urandom(32)).decode("ascii")


class VaultTests(SimpleTestCase):
    def test_round_trip_string(self):
        v = Vault(KEY)
        secret = "token-super-sensible-éàü-123"
        enc = v.encrypt(secret)
        self.assertTrue(enc.startswith(PREFIX + "."))
        self.assertNotEqual(enc, secret)
        self.assertEqual(v.decrypt(enc), secret)

    def test_round_trip_json(self):
        v = Vault(KEY)
        creds = {"token": "abc", "phoneNumberId": "123", "smtp": {"user": "a@b.c", "pass": "p"}}
        self.assertEqual(v.decrypt_json(v.encrypt_json(creds)), creds)

    def test_random_iv(self):
        v = Vault(KEY)
        self.assertNotEqual(v.encrypt("same"), v.encrypt("same"))

    def test_tamper_fails(self):
        v = Vault(KEY)
        parts = v.encrypt("donnee integre").split(".")
        ct = bytearray(base64.b64decode(parts[3]))
        ct[0] ^= 0xFF
        tampered = ".".join([parts[0], parts[1], parts[2], base64.b64encode(bytes(ct)).decode("ascii")])
        with self.assertRaises(VaultError):
            v.decrypt(tampered)

    def test_wrong_key_fails(self):
        enc = Vault(KEY).encrypt("secret")
        other = Vault(generate_key())
        with self.assertRaises(VaultError):
            other.decrypt(enc)

    def test_bad_format(self):
        v = Vault(KEY)
        with self.assertRaises(VaultError):
            v.decrypt("pas-un-format")
        with self.assertRaises(VaultError):
            v.decrypt("gcm1.only.three")

    def test_bad_key_size(self):
        with self.assertRaises(VaultError):
            Vault("trop-court")
        with self.assertRaises(VaultError):
            Vault(bytes(16))
