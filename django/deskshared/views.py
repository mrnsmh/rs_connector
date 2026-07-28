"""Views for deskshared health monitoring and actions."""

import logging

from django.conf import settings as django_settings
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .actions import ACTIONS, execute_action, get_container_logs, list_project_containers
from .checks import compute_overall, run_all_checks
from .conf import deskshared_settings
from .models import ActionLog, HealthSnapshot, NotificationPreference

logger = logging.getLogger("deskshared")


class IsSuperUser(IsAuthenticated):
    """Permission: authenticated superusers, or admins when DESKSHARED_ADMIN_ACCESS=True."""
    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        if request.user.is_superuser:
            return True
        # Allow admin users when DESKSHARED_ADMIN_ACCESS is enabled (default True)
        if getattr(django_settings, 'DESKSHARED_ADMIN_ACCESS', True):
            role = getattr(request.user, 'role', None)
            if role == 'admin':
                return True
        return False


# ──── Health Endpoints ────


class HealthFullView(APIView):
    """GET : Run all health checks and return { overall, checks }.

    Each check: { key, label, status, detail, ms, diagnostic }
    """
    permission_classes = [IsSuperUser]

    def get(self, request):
        checks = run_all_checks()
        overall = compute_overall(checks)
        return Response({"overall": overall, "checks": checks})


class HealthHistoryView(APIView):
    """GET : Return health snapshots as a flat array.

    Each snapshot: { id, project, overall, checks, created_at }
    Query params: limit (default 50)
    """
    permission_classes = [IsSuperUser]

    def get(self, request):
        limit = int(request.query_params.get("limit", 50))
        snapshots = HealthSnapshot.objects.filter(
            project=deskshared_settings.PROJECT_KEY,
        )[:limit]

        data = []
        for s in snapshots:
            data.append({
                "id": s.id,
                "project": s.project,
                "overall": s.overall,
                "checks": s.checks,
                "created_at": s.created_at.isoformat(),
            })
        return Response(data)


class HealthSnapshotCreateView(APIView):
    """POST : Manually trigger a health snapshot creation."""
    permission_classes = [IsSuperUser]

    def post(self, request):
        from .tasks import collect_health_snapshot
        result = collect_health_snapshot()
        return Response(result)


# ──── Actions Endpoints ────


class ActionsListView(APIView):
    """GET : List all available actions as a flat array.

    Each action: { key, label, description, risk, needs_password }
    """
    permission_classes = [IsSuperUser]

    def get(self, request):
        result = []
        for key, defn in ACTIONS.items():
            result.append({
                "key": key,
                "label": defn.get("label", defn["description"]),
                "description": defn["description"],
                "risk": defn["risk_level"],
                "needs_password": False,
            })
        return Response(result)


class ActionExecuteView(APIView):
    """POST : Execute an action.

    Body: { "action": "restart_container", "target": "desklink-api-1" }
    Returns: { status, detail }
    """
    permission_classes = [IsSuperUser]

    def post(self, request):
        if not deskshared_settings.ACTIONS_ENABLED:
            return Response({"status": "error", "detail": "Les actions sont désactivées"}, status=403)

        action_key = request.data.get("action", "")
        target = request.data.get("target", "")

        if not action_key:
            return Response({"status": "error", "detail": "Paramètre 'action' requis"}, status=400)

        if action_key not in ACTIONS:
            return Response({"status": "error", "detail": f"Action inconnue: {action_key}"}, status=400)

        action_def = ACTIONS[action_key]
        if action_def["requires_target"] and not target:
            return Response({"status": "error", "detail": f"Paramètre 'target' requis pour {action_key}"}, status=400)

        import time
        t = time.monotonic()
        result = execute_action(action_key, target=target)
        duration_ms = round((time.monotonic() - t) * 1000)

        # Log the action
        try:
            ActionLog.objects.create(
                user=request.user if request.user.is_authenticated else None,
                project=deskshared_settings.PROJECT_KEY,
                action=action_key,
                target=target,
                risk_level=action_def["risk_level"],
                result={**result, "duration_ms": duration_ms},
            )
        except Exception as e:
            logger.warning("Failed to log action: %s", e)

        success = result.get("success", False)
        detail = (
            result.get("stdout", "")[:500]
            if success
            else result.get("stderr", result.get("error", "Erreur inconnue"))[:500]
        )
        return Response({
            "status": "success" if success else "error",
            "detail": detail or f"Action {action_key} terminée",
        })


class ActionHistoryView(APIView):
    """GET : Return action log history as a flat array.

    Each entry: { id, action_key, status, detail, created_at }
    """
    permission_classes = [IsSuperUser]

    def get(self, request):
        limit = int(request.query_params.get("limit", 30))
        logs = ActionLog.objects.filter(
            project=deskshared_settings.PROJECT_KEY,
        )[:limit]

        data = []
        for log in logs:
            result = log.result or {}
            success = result.get("success", False)
            data.append({
                "id": log.id,
                "action_key": log.action,
                "status": "success" if success else "error",
                "detail": result.get("stdout", result.get("stderr", ""))[:200],
                "created_at": log.created_at.isoformat(),
            })
        return Response(data)


class ContainerStatusView(APIView):
    """GET : Get status of containers as a flat array.

    Each container: { name, status, state, ports }
    """
    permission_classes = [IsSuperUser]

    def get(self, request):
        project = request.query_params.get("project", deskshared_settings.PROJECT_KEY)
        compose_project = deskshared_settings.COMPOSE_PROJECTS.get(project, project)
        result = list_project_containers(compose_project)

        if result.get("success"):
            containers = []
            for c in result.get("containers", []):
                containers.append({
                    "name": c.get("name", ""),
                    "status": c.get("status", ""),
                    "state": _infer_state(c.get("status", "")),
                    "ports": c.get("ports", ""),
                })
            return Response(containers)
        return Response([])


def _infer_state(status_str: str) -> str:
    """Infer Docker state from status string like 'Up 2 hours' or 'Exited (0) 5 days ago'."""
    s = status_str.lower()
    if s.startswith("up"):
        return "running"
    if s.startswith("exited") or s.startswith("dead"):
        return "exited"
    if s.startswith("restarting"):
        return "restarting"
    if s.startswith("created"):
        return "created"
    return "unknown"


class ContainerLogsView(APIView):
    """GET : Get recent logs from a container.

    Returns: { container, logs }
    """
    permission_classes = [IsSuperUser]

    def get(self, request):
        container = request.query_params.get("container", "")
        lines = int(request.query_params.get("lines", 100))
        if not container:
            return Response({"error": "Paramètre 'container' requis"}, status=400)
        result = get_container_logs(container, lines=lines)
        logs = result.get("stdout", "") + ("\n--- STDERR ---\n" + result.get("stderr", "") if result.get("stderr") else "")
        return Response({"container": container, "logs": logs})


# ──── Notification Preferences ────


class NotificationPreferencesView(APIView):
    """GET/PUT : User notification preferences for health alerts.

    Returns: { email_enabled, email_recipients, telegram_enabled, telegram_chat_id,
               slack_enabled, slack_webhook_url, notify_on_error, notify_on_warning, notify_recovery }
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        pref, _ = NotificationPreference.objects.get_or_create(user=request.user)
        return Response(_pref_to_dict(pref))

    def put(self, request):
        pref, _ = NotificationPreference.objects.get_or_create(user=request.user)
        data = request.data
        # Map frontend boolean channels to model channel field
        if "channel" in data:
            pref.channel = data["channel"]
        else:
            # Handle boolean toggles (including disabling them)
            if "email_enabled" in data and data["email_enabled"]:
                pref.channel = "email"
            elif "telegram_enabled" in data and data["telegram_enabled"]:
                pref.channel = "telegram"
            elif "slack_enabled" in data and data["slack_enabled"]:
                pref.channel = "slack"
            elif any(k in data and not data[k] for k in ["email_enabled", "telegram_enabled", "slack_enabled"]):
                # If they explicitly send False for something and nothing else is True, fallback to in_app
                pref.channel = "in_app"

        pref.notify_on_error = data.get("notify_on_error", pref.notify_on_error)
        # Handle frontend key names (notify_recovery -> notify_on_recovery)
        pref.notify_on_recovery = data.get("notify_recovery", data.get("notify_on_recovery", pref.notify_on_recovery))
        # Handle frontend key names (notify_on_warning -> notify_on_action_failed)
        pref.notify_on_action_failed = data.get("notify_on_warning", data.get("notify_on_action_failed", pref.notify_on_action_failed))
        pref.telegram_chat_id = data.get("telegram_chat_id", pref.telegram_chat_id)
        pref.slack_webhook_url = data.get("slack_webhook_url", pref.slack_webhook_url)
        # Handle email_recipients (list) → single email_address
        if "email_recipients" in data:
            recipients = data["email_recipients"]
            pref.email_address = recipients[0] if recipients else ""
        elif "email_address" in data:
            pref.email_address = data["email_address"]
        pref.save()
        return Response(_pref_to_dict(pref))


def _pref_to_dict(pref):
    """Convert NotificationPreference to the format expected by the frontend."""
    return {
        "email_enabled": pref.channel == "email",
        "email_recipients": [pref.email_address] if pref.email_address else [],
        "telegram_enabled": pref.channel == "telegram",
        "telegram_chat_id": pref.telegram_chat_id,
        "slack_enabled": pref.channel == "slack",
        "slack_webhook_url": pref.slack_webhook_url,
        "notify_on_error": pref.notify_on_error,
        "notify_on_warning": pref.notify_on_action_failed,
        "notify_recovery": pref.notify_on_recovery,
    }
