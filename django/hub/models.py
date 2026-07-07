"""Modeles multi-tenant de RS-Connector (Option A) :
Organisation -> Profil (config + cle API) -> Connexion RS.
Le Profil remplace l'ancienne << application >> du backend Node.
"""
import uuid

from django.conf import settings
from django.db import models


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField("cree le", auto_now_add=True)
    updated_at = models.DateTimeField("modifie le", auto_now=True)

    class Meta:
        abstract = True


class Organisation(TimeStampedModel):
    """Locataire de premier niveau : un compte/organisation qui possede des profils."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField("nom", max_length=120, unique=True)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="organisations", verbose_name="proprietaire",
    )
    is_active = models.BooleanField("active", default=True)

    class Meta:
        verbose_name = "organisation"
        verbose_name_plural = "organisations"
        ordering = ["name"]

    def __str__(self):
        return self.name


class Profile(TimeStampedModel):
    """Un profil : porte sa propre configuration, ses cles API et ses connexions RS."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organisation = models.ForeignKey(
        Organisation, on_delete=models.CASCADE, related_name="profiles", verbose_name="organisation",
    )
    name = models.CharField("nom", max_length=120)
    config = models.JSONField("configuration", default=dict, blank=True)
    webhook_url = models.URLField("URL webhook (defaut)", max_length=500, blank=True, default="")
    webhook_secret = models.CharField("secret webhook", max_length=128, blank=True, default="")
    is_active = models.BooleanField("actif", default=True)

    class Meta:
        verbose_name = "profil"
        verbose_name_plural = "profils"
        ordering = ["organisation__name", "name"]
        constraints = [
            models.UniqueConstraint(fields=["organisation", "name"], name="uniq_profil_par_organisation"),
        ]

    def __str__(self):
        return f"{self.name} ({self.organisation.name})"


class ApiKey(TimeStampedModel):
    """Cle API d'un profil. On ne stocke que le hash SHA-256 ; le prefixe sert a l'affichage."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    profile = models.ForeignKey(
        Profile, on_delete=models.CASCADE, related_name="api_keys", verbose_name="profil",
    )
    label = models.CharField("libelle", max_length=120, blank=True, default="")
    prefix = models.CharField("prefixe", max_length=16, db_index=True)
    key_hash = models.CharField("hash de la cle", max_length=128, unique=True)
    last_used_at = models.DateTimeField("derniere utilisation", null=True, blank=True)
    revoked_at = models.DateTimeField("revoquee le", null=True, blank=True)

    class Meta:
        verbose_name = "cle API"
        verbose_name_plural = "cles API"
        ordering = ["-created_at"]

    @property
    def is_active(self):
        return self.revoked_at is None

    def __str__(self):
        return f"{self.prefix}... ({self.profile.name}, {'revoquee' if self.revoked_at else 'active'})"


class Connection(TimeStampedModel):
    """Connexion RS rattachee a un profil (WhatsApp Baileys, WhatsApp Cloud, Telegram, Email)."""

    class Channel(models.TextChoices):
        WHATSAPP_BAILEYS = "whatsapp_baileys", "WhatsApp - Baileys (QR)"
        WHATSAPP_CLOUD = "whatsapp_cloud", "WhatsApp Cloud - Meta"
        TELEGRAM = "telegram", "Telegram"
        EMAIL = "email", "Email - SMTP/IMAP"

    class Status(models.TextChoices):
        DISCONNECTED = "disconnected", "deconnectee"
        CONNECTING = "connecting", "connexion..."
        QR_REQUIRED = "qr_required", "QR requis"
        CONNECTED = "connected", "connectee"
        LOGGED_OUT = "logged_out", "session fermee"
        ERROR = "error", "erreur"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    profile = models.ForeignKey(
        Profile, on_delete=models.CASCADE, related_name="connections", verbose_name="profil",
    )
    connection_id = models.CharField("identifiant de connexion", max_length=120)
    channel_type = models.CharField("canal", max_length=32, choices=Channel.choices)
    credentials_encrypted = models.TextField("credentials chiffres (AES-256-GCM)", blank=True, default="")
    webhook_url = models.URLField("URL webhook (surcharge)", max_length=500, blank=True, default="")
    status = models.CharField("statut", max_length=20, choices=Status.choices, default=Status.DISCONNECTED)
    meta = models.JSONField("metadonnees", default=dict, blank=True)

    class Meta:
        verbose_name = "connexion"
        verbose_name_plural = "connexions"
        ordering = ["profile__name", "connection_id"]
        constraints = [
            models.UniqueConstraint(fields=["profile", "connection_id"], name="uniq_connexion_par_profil"),
        ]

    def __str__(self):
        return f"{self.connection_id} [{self.get_channel_type_display()}] - {self.profile.name}"

    def baileys_session_dir(self):
        """Chemin d'auth Baileys ISOLE par profil (exigence : une session Baileys par profil)."""
        return f"{self.profile_id}/{self.connection_id}"
