"""Authentification DRF par cle API (en-tete Authorization: Bearer <cle>).

On hache la cle presentee (SHA-256) et on cherche l'ApiKey correspondante non revoquee ;
le profil rattache sert au scoping strict (un profil ne voit que SES connexions).
"""
from django.utils import timezone
from rest_framework import authentication, exceptions

from .api_keys import hash_api_key
from .models import ApiKey


class ApiClient:
    """Identite d'un client API authentifie (n'est pas un utilisateur Django)."""

    is_authenticated = True

    def __init__(self, profile, api_key):
        self.profile = profile
        self.api_key = api_key

    def __str__(self):
        return f"api-client:{self.profile.name}"


class ApiKeyAuthentication(authentication.BaseAuthentication):
    keyword = "Bearer"

    def authenticate(self, request):
        header = authentication.get_authorization_header(request).decode("latin1").strip()
        if not header:
            return None
        parts = header.split()
        if parts[0].lower() != self.keyword.lower():
            return None
        if len(parts) != 2:
            raise exceptions.AuthenticationFailed("En-tete Authorization mal forme")
        token = parts[1].strip()
        try:
            api_key = (
                ApiKey.objects.select_related("profile", "profile__organisation")
                .get(key_hash=hash_api_key(token), revoked_at__isnull=True)
            )
        except ApiKey.DoesNotExist:
            raise exceptions.AuthenticationFailed("Cle API invalide ou revoquee")
        if not api_key.profile.is_active or not api_key.profile.organisation.is_active:
            raise exceptions.AuthenticationFailed("Profil ou organisation desactive")
        ApiKey.objects.filter(pk=api_key.pk).update(last_used_at=timezone.now())
        return (ApiClient(api_key.profile, api_key), api_key)

    def authenticate_header(self, request):
        # Force une reponse 401 (et non 403) quand aucune cle valide n'est fournie.
        return self.keyword
