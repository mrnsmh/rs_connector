"""Importe les donnees de l'ancienne base Node (applications + connections) vers le modele
multi-tenant Django (Organisation -> Profil -> Connexion + Cle API).

Entree : JSON {"applications":[...], "connections":[...]} via --file ou stdin, produit par
psql (row_to_json) sur la base Node. Les hash de cle API et les credentials chiffres sont
copies VERBATIM (formats byte-compatibles verifies), donc les cles existantes restent valides
et les credentials restent dechiffrables avec la meme CREDENTIALS_ENCRYPTION_KEY.

Idempotent : re-executable sans doublon (get_or_create par cles naturelles). --dry-run simule.
"""
import json
import sys

from django.core.management.base import BaseCommand
from django.db import transaction

from hub.models import ApiKey, Connection, Organisation, Profile

STATUS_MAP = {"initializing": "connecting"}
VALID_STATUSES = {c[0] for c in Connection.Status.choices}
FALLBACK_PROFILE = "Profil importe (sans application)"


class Command(BaseCommand):
    help = "Importe applications/connexions de la base Node (JSON) vers Organisation/Profil/Connexion."

    def add_arguments(self, parser):
        parser.add_argument("--org-name", default="Organisation par defaut")
        parser.add_argument("--file", default=None, help="Chemin du JSON (sinon lecture stdin)")
        parser.add_argument("--dry-run", action="store_true", help="Simule sans ecrire (rollback)")

    def handle(self, *args, **opts):
        raw = open(opts["file"], encoding="utf-8").read() if opts["file"] else sys.stdin.read()
        data = json.loads(raw)
        apps = data.get("applications") or []
        conns = data.get("connections") or []

        counters = {"profils": 0, "cles": 0, "connexions": 0, "orphelines": 0, "ignorees": 0}
        with transaction.atomic():
            org, _ = Organisation.objects.get_or_create(name=opts["org_name"])
            prof_by_appid = {}
            for a in apps:
                prof, created = Profile.objects.get_or_create(
                    organisation=org, name=a.get("name") or f"app-{a.get('id')}",
                    defaults={
                        "webhook_url": a.get("webhook_url") or "",
                        "webhook_secret": a.get("webhook_secret") or "",
                        "is_active": (a.get("status") or "active") == "active",
                    },
                )
                prof_by_appid[a.get("id")] = prof
                counters["profils"] += int(created)
                h = a.get("api_key_hash")
                if h and not ApiKey.objects.filter(key_hash=h).exists():
                    ApiKey.objects.create(
                        profile=prof, prefix=a.get("api_key_prefix") or h[:12], key_hash=h)
                    counters["cles"] += 1

            for c in conns:
                prof = prof_by_appid.get(c.get("application_id"))
                if prof is None:
                    prof, _ = Profile.objects.get_or_create(organisation=org, name=FALLBACK_PROFILE)
                    counters["orphelines"] += 1
                if Connection.objects.filter(profile=prof, connection_id=c["connection_id"]).exists():
                    counters["ignorees"] += 1
                    continue
                status = STATUS_MAP.get(c.get("status"), c.get("status") or "disconnected")
                if status not in VALID_STATUSES:
                    status = "disconnected"
                Connection.objects.create(
                    profile=prof,
                    connection_id=c["connection_id"],
                    channel_type=c.get("channel_type") or "whatsapp_baileys",
                    credentials_encrypted=c.get("credentials_encrypted") or "",
                    webhook_url=c.get("webhook_url") or "",
                    status=status,
                )
                counters["connexions"] += 1

            if opts["dry_run"]:
                transaction.set_rollback(True)

        mode = "[DRY-RUN] " if opts["dry_run"] else ""
        self.stdout.write(f"{mode}Organisation: {opts['org_name']}")
        self.stdout.write(
            f"{mode}Profils crees={counters['profils']} Cles={counters['cles']} "
            f"Connexions={counters['connexions']} (orphelines rattachees={counters['orphelines']}, "
            f"deja presentes={counters['ignorees']})"
        )
