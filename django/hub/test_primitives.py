"""Tests des primitives API : cles API (hash) et signature de webhook (HMAC)."""
import hashlib
import hmac

from django.test import SimpleTestCase

from hub import webhooks
from hub.api_keys import (
    API_KEY_PREFIX,
    VISIBLE_PREFIX_LENGTH,
    generate_api_key,
    generate_webhook_secret,
    hash_api_key,
)


class ApiKeyTests(SimpleTestCase):
    def test_generate_shape(self):
        k = generate_api_key()
        self.assertTrue(k["api_key"].startswith(API_KEY_PREFIX))
        self.assertEqual(k["prefix"], k["api_key"][:VISIBLE_PREFIX_LENGTH])
        self.assertEqual(k["hash"], hashlib.sha256(k["api_key"].encode()).hexdigest())
        self.assertEqual(len(k["hash"]), 64)

    def test_hash_deterministic(self):
        self.assertEqual(hash_api_key("dk_abc"), hash_api_key("dk_abc"))
        self.assertEqual(hash_api_key("dk_abc"), hashlib.sha256(b"dk_abc").hexdigest())

    def test_keys_unique(self):
        self.assertNotEqual(generate_api_key()["api_key"], generate_api_key()["api_key"])

    def test_webhook_secret_prefix(self):
        self.assertTrue(generate_webhook_secret().startswith("whsec_"))


class WebhookSignTests(SimpleTestCase):
    def test_sign_format(self):
        self.assertTrue(webhooks.sign({"a": 1}, "secret").startswith("sha256="))

    def test_sign_matches_manual_hmac_for_string(self):
        payload = '{"event":"message.received"}'
        expected = "sha256=" + hmac.new(b"sec", payload.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(webhooks.sign(payload, "sec"), expected)

    def test_verify_roundtrip(self):
        sig = webhooks.sign({"a": 1}, "sec")
        self.assertTrue(webhooks.verify({"a": 1}, "sec", sig))
        self.assertFalse(webhooks.verify({"a": 2}, "sec", sig))
        self.assertFalse(webhooks.verify({"a": 1}, "wrong", sig))

    def test_no_secret_raises(self):
        with self.assertRaises(ValueError):
            webhooks.sign({"a": 1}, "")
