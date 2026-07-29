"""Views d'authentification pour le SPA rsconnect (/admin, /admin/google)."""
import json

from django.contrib.auth import authenticate, login, logout
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.views import View
from django.views.decorators.csrf import csrf_exempt, ensure_csrf_cookie
from django.utils.decorators import method_decorator


@method_decorator(csrf_exempt, name="dispatch")
class AdminAuthView(View):
    """GET  /admin  -> info utilisateur connecte (ou 401)
       POST /admin  -> login (username + password)"""

    def get(self, request):
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Non authentifie"}, status=401)
        u = request.user
        return JsonResponse({
            "user": {
                "id": u.id,
                "username": u.username,
                "email": u.email,
                "is_superuser": u.is_superuser,
                "is_staff": u.is_staff,
            },
            "csrfToken": get_token(request),
        })

    def post(self, request):
        try:
            data = json.loads(request.body)
        except (json.JSONDecodeError, ValueError):
            data = request.POST

        username = data.get("username", "").strip()
        password = data.get("password", "")

        if not username or not password:
            return JsonResponse({"error": "Identifiants requis"}, status=400)

        user = authenticate(request, username=username, password=password)
        if user is None:
            return JsonResponse({"error": "Identifiants incorrects"}, status=401)

        login(request, user)
        return JsonResponse({
            "user": {
                "id": user.id,
                "username": user.username,
                "email": user.email,
                "is_superuser": user.is_superuser,
                "is_staff": user.is_staff,
            },
            "csrfToken": get_token(request),
        })


@method_decorator(csrf_exempt, name="dispatch")
class AdminGoogleView(View):
    """POST /admin/google -> login via Google OAuth credential."""

    def post(self, request):
        try:
            data = json.loads(request.body)
        except (json.JSONDecodeError, ValueError):
            return JsonResponse({"error": "Donnees invalides"}, status=400)

        credential = data.get("credential")
        if not credential:
            return JsonResponse({"error": "Credential manquant"}, status=400)

        return JsonResponse({"error": "Google OAuth non configure"}, status=501)


@method_decorator(csrf_exempt, name="dispatch")
class AdminLogoutView(View):
    """POST /admin/logout -> deconnexion."""

    def post(self, request):
        logout(request)
        return JsonResponse({"ok": True})
