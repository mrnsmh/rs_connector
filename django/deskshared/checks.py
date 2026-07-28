"""Health check engine — runs individual checks and aggregates results.

Each check returns:
{
    "key": str,
    "label": str,
    "status": "ok" | "warn" | "error",
    "detail": str,
    "ms": int | None,
    "diagnostic": {"cause": str, "fix": str} | None,
}
"""

import logging
import time

from django.conf import settings
from .conf import deskshared_settings

logger = logging.getLogger("deskshared.checks")


def _timed(fn):
    """Run fn, return (result, ms)."""
    start = time.monotonic()
    try:
        result = fn()
    except Exception as exc:
        elapsed = int((time.monotonic() - start) * 1000)
        return {"status": "error", "detail": str(exc), "diagnostic": {
            "cause": f"Exception: {exc}",
            "fix": "Vérifier les logs du service pour plus de détails.",
        }}, elapsed
    elapsed = int((time.monotonic() - start) * 1000)
    return result, elapsed


def check_db():
    """Check PostgreSQL connectivity."""
    from django.db import connection

    def _check():
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        return {"status": "ok", "detail": "PostgreSQL OK"}

    result, ms = _timed(_check)
    result.update({"key": "db", "label": "Base de données (PostgreSQL)", "ms": ms})
    if result["status"] == "error":
        result["diagnostic"] = {
            "cause": "PostgreSQL inaccessible ou crashed",
            "fix": "Vérifier que postgres tourne : docker ps | grep postgres. Vérifier les logs : docker logs deskassit-postgres-1 --tail 50",
        }
    return result


def check_redis():
    """Check Redis connectivity."""
    import redis as redis_lib

    def _check():
        url = getattr(settings, "CELERY_BROKER_URL", "redis://127.0.0.1:6379/0")
        r = redis_lib.from_url(url, socket_connect_timeout=3)
        r.ping()
        return {"status": "ok", "detail": f"Redis OK ({url.split('@')[-1]})"}

    result, ms = _timed(_check)
    result.update({"key": "redis", "label": "Redis (Broker)", "ms": ms})
    if result["status"] == "error":
        result["diagnostic"] = {
            "cause": "Redis inaccessible ou crashed",
            "fix": "Vérifier que redis tourne : docker ps | grep redis. Restart : docker restart deskassit-redis-1",
        }
    return result


def check_bridge():
    """Check WhatsApp bridge connectivity."""
    import urllib.request
    import urllib.error
    import json

    bridge_url = getattr(settings, "WHATSAPP_BRIDGE_URL", "http://127.0.0.1:3006")

    def _check():
        try:
            req = urllib.request.Request(f"{bridge_url}/health", method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                connected = data.get("connected", False)
                if connected:
                    return {"status": "ok", "detail": "Bridge connecté à WhatsApp"}
                else:
                    return {"status": "warn", "detail": "Bridge actif mais déconnecté de WhatsApp"}
        except urllib.error.URLError:
            return {"status": "error", "detail": "Bridge inaccessible"}

    result, ms = _timed(_check)
    result.update({"key": "bridge", "label": "WhatsApp Bridge", "ms": ms})
    if result["status"] == "error":
        result["diagnostic"] = {
            "cause": "Service Baileys (Node.js) ne répond pas",
            "fix": "Vérifier : docker ps | grep baileys. Logs : docker logs deskassit-baileys-bridge-1 --tail 50. Restart : docker restart deskassit-baileys-bridge-1",
        }
    elif result["status"] == "warn":
        result["diagnostic"] = {
            "cause": "Bridge up mais session WhatsApp expirée ou déconnectée",
            "fix": "Vérifier le statut de la session WhatsApp via /api/v1/whatsapp/status/. Peut nécessiter un re-scan du QR code.",
        }
    return result


def check_ai():
    """Check AI engine availability (DeepSeek primary)."""
    import urllib.request
    import urllib.error

    api_key = getattr(settings, "DEEPSEEK_API_KEY", "")
    base_url = getattr(settings, "DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")

    def _check():
        if not api_key:
            return {"status": "warn", "detail": "DeepSeek API key non configurée"}
        try:
            req = urllib.request.Request(
                f"{base_url}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    return {"status": "ok", "detail": "DeepSeek API accessible"}
                return {"status": "warn", "detail": f"DeepSeek API retourne {resp.status}"}
        except urllib.error.HTTPError as e:
            return {"status": "error", "detail": f"DeepSeek API erreur HTTP {e.code}"}
        except Exception as e:
            return {"status": "error", "detail": f"DeepSeek API: {e}"}

    result, ms = _timed(_check)
    result.update({"key": "ai", "label": "IA (DeepSeek)", "ms": ms})
    if result["status"] == "error":
        result["diagnostic"] = {
            "cause": "Clé API invalide, quota dépassé, ou service DeepSeek down",
            "fix": "Vérifier DEEPSEEK_API_KEY dans .env. Tester manuellement : curl -H 'Authorization: Bearer $KEY' https://api.deepseek.com/v1/models",
        }
    return result


def check_celery():
    """Check Celery worker availability."""
    from celery import current_app

    def _check():
        try:
            inspector = current_app.control.inspect(timeout=3)
            active = inspector.ping()
            if active:
                workers = list(active.keys())
                return {"status": "ok", "detail": f"Celery worker(s): {', '.join(workers)}"}
            return {"status": "error", "detail": "Aucun Celery worker actif"}
        except Exception as e:
            return {"status": "error", "detail": f"Celery inspect failed: {e}"}

    result, ms = _timed(_check)
    result.update({"key": "celery", "label": "Celery Worker", "ms": ms})
    if result["status"] == "error":
        result["diagnostic"] = {
            "cause": "Aucun worker Celery actif ou Redis inaccessible pour Celery",
            "fix": "Vérifier : ps aux | grep celery. Restart : docker restart deskassit-celery-1. Vérifier les logs worker.",
        }
    return result


def check_system():
    """Check system resources (disk, memory)."""
    import shutil
    import os

    def _check():
        issues = []
        # Disk
        disk = shutil.disk_usage("/")
        pct_used = (disk.used / disk.total) * 100
        if pct_used > 90:
            issues.append(f"Disque critique: {pct_used:.0f}% utilisé")
        elif pct_used > 80:
            issues.append(f"Disque en hausse: {pct_used:.0f}% utilisé")

        # Memory (Linux)
        try:
            with open("/proc/meminfo") as f:
                meminfo = {}
                for line in f:
                    parts = line.split(":")
                    if len(parts) == 2:
                        key = parts[0].strip()
                        val = int(parts[1].strip().split()[0])
                        meminfo[key] = val
            total = meminfo.get("MemTotal", 0)
            available = meminfo.get("MemAvailable", 0)
            if total > 0:
                pct_mem = ((total - available) / total) * 100
                if pct_mem > 90:
                    issues.append(f"Mémoire critique: {pct_mem:.0f}% utilisée")
                elif pct_mem > 80:
                    issues.append(f"Mémoire en hausse: {pct_mem:.0f}% utilisée")
        except FileNotFoundError:
            pass  # Not Linux

        if issues:
            return {"status": "warn", "detail": "; ".join(issues)}
        return {"status": "ok", "detail": "Ressources système OK"}

    result, ms = _timed(_check)
    result.update({"key": "system", "label": "Système (Disque/RAM)", "ms": ms})
    if result["status"] == "warn":
        result["diagnostic"] = {
            "cause": "Ressources système faibles",
            "fix": "Vérifier l'espace disque : df -h. Nettoyer les logs : docker system prune. Vérifier la RAM : free -h",
        }
    return result


# --- Cross-service checks (called from full check) ---

def check_cross_service(name, url):
    """Check if another Desk* service is reachable.

    Uses Docker CLI (available in the container) to check if the service's
    container is running. Falls back to HTTP if no socket.
    """
    import subprocess

    def _check():
        compose_projects = deskshared_settings.COMPOSE_PROJECTS
        project_name = compose_projects.get(name, name)

        # Try Docker CLI to check container status
        try:
            result = subprocess.run(
                ["docker", "ps", "--filter", f"label=com.docker.compose.project={project_name}",
                 "--format", "{{.Names}} {{.Status}}"],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                lines = result.stdout.strip().split("\n")
                first = lines[0]
                if "Up" in first:
                    return {"status": "ok", "detail": f"{name} en cours ({first.split()[0]})"}
                else:
                    return {"status": "error", "detail": f"{name} container: {first}"}
            # No matching container found
            return {"status": "error", "detail": f"{name} aucun container (project={project_name})"}
        except Exception as e:
            logger.debug("Docker CLI check failed, trying HTTP: %s", e)

        # Fallback: try HTTP health endpoints
        import urllib.request
        import urllib.error
        for path in ["/api/v1/health/full/", "/health/", "/health"]:
            try:
                req = urllib.request.Request(f"{url}{path}", method="GET")
                with urllib.request.urlopen(req, timeout=5) as resp:
                    return {"status": "ok", "detail": f"{name} répond OK (HTTP {resp.status})"}
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    return {"status": "ok", "detail": f"{name} répond OK (auth requise)"}
                if e.code == 404:
                    continue
                return {"status": "error", "detail": f"{name} inaccessible (HTTP {e.code})"}
            except urllib.error.URLError:
                return {"status": "error", "detail": f"{name} inaccessible"}
            except Exception as e:
                return {"status": "error", "detail": f"{name}: {e}"}
        return {"status": "warn", "detail": f"{name} répond mais aucun endpoint de santé trouvé"}

    result, ms = _timed(_check)
    result.update({"key": f"cross_{name.lower().replace(' ', '_')}", "label": f"Service: {name}", "ms": ms})
    if result["status"] == "error":
        result["diagnostic"] = {
            "cause": f"Le service {name} n'est pas joignable",
            "fix": f"Vérifier que {name} tourne : docker ps | grep {name.lower().replace(' ', '-')}",
        }
    return result


# --- Aggregation ---

ALL_CHECKS = [
    check_db,
    check_redis,
    check_bridge,
    check_ai,
    check_celery,
    check_system,
]


def run_all_checks(include_cross_service=True):
    """Run all checks and return list of results."""
    results = []
    for check_fn in ALL_CHECKS:
        try:
            results.append(check_fn())
        except Exception as exc:
            logger.exception("Check %s crashed", check_fn.__name__)
            results.append({
                "key": check_fn.__name__,
                "label": check_fn.__name__,
                "status": "error",
                "detail": f"Check crashed: {exc}",
                "ms": 0,
                "diagnostic": {"cause": str(exc), "fix": "Vérifier les logs Django."},
            })

    # Cross-service checks
    if include_cross_service:
        cross_services = deskshared_settings.SERVICE_URLS
        current_project = deskshared_settings.PROJECT_KEY
        for name, url in cross_services.items():
            if name == current_project:
                continue  # Don't check ourselves
            try:
                results.append(check_cross_service(name, url))
            except Exception as exc:
                logger.exception("Cross-service check %s crashed", name)
                results.append({
                    "key": f"cross_{name}",
                    "label": f"Service: {name}",
                    "status": "error",
                    "detail": f"Check crashed: {exc}",
                    "ms": 0,
                    "diagnostic": {"cause": str(exc), "fix": "Vérifier la config DESKSHARED_SERVICE_URLS."},
                })

    return results


def compute_overall(checks):
    """Compute overall status from list of check results."""
    statuses = [c.get("status", "ok") for c in checks]
    if "error" in statuses:
        return "error"
    if "warn" in statuses:
        return "warn"
    return "ok"
