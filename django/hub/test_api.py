"""Tests de l'API cliente /v1 (auth cle API, scoping strict, validation, delegation worker)."""
import json
from unittest import mock

from django.test import TestCase

from hub.api_keys import generate_api_key
from hub.models import ApiKey, Connection, Organisation, Profile


class ApiBase(TestCase):
    def setUp(self):
        self.org = Organisation.objects.create(name="Org A")
        self.profile = Profile.objects.create(organisation=self.org, name="Profil A")
        self.other = Profile.objects.create(organisation=self.org, name="Profil B")
        gen = generate_api_key()
        self.plain_key = gen["api_key"]
        ApiKey.objects.create(profile=self.profile, prefix=gen["prefix"], key_hash=gen["hash"])
        self.conn_tg = Connection.objects.create(
            profile=self.profile, connection_id="tg-1", channel_type="telegram")

    def auth(self):
        return {"HTTP_AUTHORIZATION": f"Bearer {self.plain_key}"}

    def post_msg(self, body, **extra):
        return self.client.post("/v1/messages", data=json.dumps(body),
                                content_type="application/json", **extra)


class AuthScopingTests(ApiBase):
    def test_no_key_401(self):
        self.assertEqual(self.client.get("/v1/connections").status_code, 401)

    def test_bad_key_401(self):
        r = self.client.get("/v1/connections", HTTP_AUTHORIZATION="Bearer dk_wrong")
        self.assertEqual(r.status_code, 401)

    def test_list_is_scoped_to_profile(self):
        Connection.objects.create(profile=self.other, connection_id="tg-other", channel_type="telegram")
        r = self.client.get("/v1/connections", **self.auth())
        self.assertEqual(r.status_code, 200)
        ids = [c["connectionId"] for c in r.json()["connexions"]]
        self.assertIn("tg-1", ids)
        self.assertNotIn("tg-other", ids)

    def test_detail_other_profile_404(self):
        Connection.objects.create(profile=self.other, connection_id="tg-other", channel_type="telegram")
        r = self.client.get("/v1/connections/tg-other", **self.auth())
        self.assertEqual(r.status_code, 404)


class MessagesTests(ApiBase):
    def test_missing_fields(self):
        r = self.post_msg({"to": "x"}, **self.auth())
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "missing_fields")

    def test_connection_not_found(self):
        r = self.post_msg({"connection_id": "nope", "to": "x", "text": "y"}, **self.auth())
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()["error"], "connection_not_found")

    def test_channel_mismatch(self):
        r = self.post_msg({"connection_id": "tg-1", "channel": "email", "to": "x", "text": "y"}, **self.auth())
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "channel_mismatch")

    def test_ambiguous_connection(self):
        Connection.objects.create(profile=self.profile, connection_id="tg-2", channel_type="telegram")
        r = self.post_msg({"channel": "telegram", "to": "x", "text": "y"}, **self.auth())
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"], "ambiguous_connection")

    def test_worker_unavailable_when_not_configured(self):
        r = self.post_msg({"connection_id": "tg-1", "to": "x", "text": "y"}, **self.auth())
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["error"], "worker_unavailable")

    def test_happy_path_delegates_to_worker(self):
        with mock.patch("hub.api_views.worker_client.send_message",
                        return_value={"messageId": "m1", "status": "sent"}) as sent:
            r = self.post_msg({"connection_id": "tg-1", "to": "212600000000", "text": "salut"}, **self.auth())
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["messageId"], "m1")
        self.assertEqual(body["connectionId"], "tg-1")
        self.assertEqual(body["channel"], "telegram")
        sent.assert_called_once()
