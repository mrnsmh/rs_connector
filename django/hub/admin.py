"""Enregistrement admin Django : tout est gerable depuis /admin/ (exigence utilisateur).
Organisation -> Profils (inline) ; Profil -> Cles API (lecture seule, generees par action) + Connexions.
"""
import json

from django import forms
from django.conf import settings
from django.contrib import admin, messages

from .api_keys import generate_api_key
from .crypto_vault import Vault, VaultError
from .models import ApiKey, Connection, Organisation, Profile


class ProfileInline(admin.TabularInline):
    model = Profile
    extra = 0
    show_change_link = True
    fields = ("name", "is_active", "webhook_url")


class ApiKeyInline(admin.TabularInline):
    model = ApiKey
    extra = 0
    fields = ("prefix", "label", "last_used_at", "revoked_at", "created_at")
    readonly_fields = ("prefix", "last_used_at", "created_at")

    def has_add_permission(self, request, obj=None):
        # Les cles se creent via l'action "Generer une cle API" (la valeur en clair n'est
        # montree qu'une fois et n'est jamais stockee) ; pas de saisie manuelle du hash.
        return False


class ConnectionInline(admin.TabularInline):
    model = Connection
    extra = 0
    show_change_link = True
    fields = ("connection_id", "channel_type", "status", "webhook_url")
    readonly_fields = ("status",)


@admin.register(Organisation)
class OrganisationAdmin(admin.ModelAdmin):
    list_display = ("name", "owner", "is_active", "created_at")
    search_fields = ("name",)
    list_filter = ("is_active",)
    inlines = [ProfileInline]


@admin.register(Profile)
class ProfileAdmin(admin.ModelAdmin):
    list_display = ("name", "organisation", "cles_actives", "connexions", "is_active", "created_at")
    search_fields = ("name", "organisation__name")
    list_filter = ("is_active", "organisation")
    inlines = [ApiKeyInline, ConnectionInline]
    actions = ["generer_cle_api"]

    @admin.display(description="cles actives")
    def cles_actives(self, obj):
        return obj.api_keys.filter(revoked_at__isnull=True).count()

    @admin.display(description="connexions")
    def connexions(self, obj):
        return obj.connections.count()

    @admin.action(description="Generer une nouvelle cle API (affichee une seule fois)")
    def generer_cle_api(self, request, queryset):
        for profile in queryset:
            gen = generate_api_key()
            ApiKey.objects.create(profile=profile, prefix=gen["prefix"], key_hash=gen["hash"])
            messages.warning(
                request,
                f"Cle API pour « {profile.name} » — COPIEZ-LA MAINTENANT (non re-affichee) : {gen['api_key']}",
            )


@admin.register(ApiKey)
class ApiKeyAdmin(admin.ModelAdmin):
    list_display = ("prefix", "profile", "label", "active_flag", "last_used_at", "created_at")
    search_fields = ("prefix", "profile__name")
    list_filter = ("profile__organisation",)
    readonly_fields = ("key_hash", "prefix", "last_used_at", "created_at", "updated_at")

    def has_add_permission(self, request):
        return False

    @admin.display(boolean=True, description="active")
    def active_flag(self, obj):
        return obj.is_active


class ConnectionAdminForm(forms.ModelForm):
    credentials_plain = forms.CharField(
        label="Credentials (JSON — chiffres au stockage)", required=False,
        widget=forms.Textarea(attrs={"rows": 3, "placeholder": '{"token": "123456:ABC-DEF..."}'}),
        help_text="JSON des identifiants du canal ; sera chiffre en AES-256-GCM. Laisser vide pour ne pas modifier.",
    )

    class Meta:
        model = Connection
        fields = ("profile", "connection_id", "channel_type", "webhook_url")

    def clean_credentials_plain(self):
        raw = (self.cleaned_data.get("credentials_plain") or "").strip()
        if raw:
            try:
                json.loads(raw)
            except ValueError:
                raise forms.ValidationError("JSON invalide.")
        return raw


@admin.register(Connection)
class ConnectionAdmin(admin.ModelAdmin):
    form = ConnectionAdminForm
    list_display = ("connection_id", "channel_type", "profile", "status", "credentials_set", "created_at")
    search_fields = ("connection_id", "profile__name")
    list_filter = ("channel_type", "status", "profile__organisation")
    readonly_fields = ("status", "credentials_set", "created_at", "updated_at")

    @admin.display(boolean=True, description="credentials configures")
    def credentials_set(self, obj):
        return bool(obj.credentials_encrypted)

    def save_model(self, request, obj, form, change):
        raw = (form.cleaned_data.get("credentials_plain") or "").strip()
        if raw:
            key = getattr(settings, "CREDENTIALS_ENCRYPTION_KEY", "")
            if not key:
                messages.error(request, "CREDENTIALS_ENCRYPTION_KEY non configuree : credentials non enregistres.")
            else:
                try:
                    obj.credentials_encrypted = Vault(key).encrypt_json(json.loads(raw))
                    messages.success(request, "Credentials chiffres et enregistres.")
                except VaultError as exc:
                    messages.error(request, f"Chiffrement impossible : {exc}")
        super().save_model(request, obj, form, change)
