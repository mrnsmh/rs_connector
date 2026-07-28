"""Action engine for deskshared.

Provides safe restart/control actions for Docker containers and services.
Each action returns a standardized result dict.
"""

import logging
import subprocess
import time

logger = logging.getLogger("deskshared")


def _run_cmd(cmd: list, timeout: int = 30) -> dict:
    """Run a shell command and return standardized result."""
    t = time.monotonic()
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        duration_ms = round((time.monotonic() - t) * 1000)
        return {
            "success": result.returncode == 0,
            "exit_code": result.returncode,
            "stdout": result.stdout.strip()[:2000],
            "stderr": result.stderr.strip()[:2000],
            "duration_ms": duration_ms,
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Command timed out after {timeout}s",
            "duration_ms": round((time.monotonic() - t) * 1000),
        }
    except Exception as e:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": str(e)[:500],
            "duration_ms": round((time.monotonic() - t) * 1000),
        }


def restart_container(container_name: str) -> dict:
    """Restart a Docker container by name."""
    logger.warning("ACTION: restart_container %s", container_name)
    return _run_cmd(["docker", "restart", container_name], timeout=60)


def stop_container(container_name: str) -> dict:
    """Stop a Docker container."""
    logger.warning("ACTION: stop_container %s", container_name)
    return _run_cmd(["docker", "stop", container_name], timeout=30)


def start_container(container_name: str) -> dict:
    """Start a Docker container."""
    logger.warning("ACTION: start_container %s", container_name)
    return _run_cmd(["docker", "start", container_name], timeout=30)


def get_container_status(container_name: str) -> dict:
    """Get detailed status of a Docker container."""
    result = _run_cmd(
        ["docker", "inspect", "--format", "{{.State.Status}}|{{.State.Health.Status}}|{{.State.StartedAt}}", container_name],
        timeout=10,
    )
    if result["success"]:
        parts = result["stdout"].split("|")
        return {
            "success": True,
            "status": parts[0] if len(parts) > 0 else "unknown",
            "health": parts[1] if len(parts) > 1 else "none",
            "started_at": parts[2] if len(parts) > 2 else "",
        }
    return result


def get_container_logs(container_name: str, lines: int = 50) -> dict:
    """Get recent logs from a Docker container."""
    return _run_cmd(
        ["docker", "logs", "--tail", str(lines), container_name],
        timeout=10,
    )


def list_project_containers(compose_project: str = "") -> dict:
    """List all containers for a docker-compose project."""
    result = _run_cmd(
        ["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={compose_project}",
         "--format", "{{.Names}}|{{.Status}}|{{.Ports}}"],
        timeout=10,
    )
    if result["success"]:
        containers = []
        for line in result["stdout"].split("\n"):
            if line.strip():
                parts = line.split("|")
                containers.append({
                    "name": parts[0] if len(parts) > 0 else "",
                    "status": parts[1] if len(parts) > 1 else "",
                    "ports": parts[2] if len(parts) > 2 else "",
                })
        return {"success": True, "containers": containers}
    return result


def celery_inspect(worker_container: str, command: str = "ping") -> dict:
    """Run a Celery inspect command on a worker container."""
    return _run_cmd(
        ["docker", "exec", worker_container, "celery", "-A", "config", "inspect", command, "--timeout=5"],
        timeout=15,
    )


def celery_ping(worker_container: str) -> dict:
    """Ping Celery workers."""
    return celery_inspect(worker_container, "ping")


def celery_active(worker_container: str) -> dict:
    """Get active Celery tasks."""
    return celery_inspect(worker_container, "active")


def celery_shutdown(worker_container: str) -> dict:
    """Gracefully shutdown a Celery worker (it will auto-restart via Docker)."""
    logger.warning("ACTION: celery_shutdown %s", worker_container)
    return _run_cmd(
        ["docker", "exec", worker_container, "celery", "-A", "config", "control", "shutdown"],
        timeout=10,
    )


def reload_nginx() -> dict:
    """Reload nginx configuration (graceful, zero downtime)."""
    logger.warning("ACTION: reload_nginx")
    return _run_cmd(["nginx", "-s", "reload"], timeout=10)


def get_system_info() -> dict:
    """Get system information."""
    info = {}

    # Uptime
    result = _run_cmd(["uptime", "-p"], timeout=5)
    if result["success"]:
        info["uptime"] = result["stdout"]

    # Docker info
    result = _run_cmd(["docker", "info", "--format", "{{.ContainersRunning}} containers running"], timeout=5)
    if result["success"]:
        info["docker"] = result["stdout"]

    return info


# ──── Action Registry ────

ACTIONS = {
    "restart_container": {
        "func": restart_container,
        "risk_level": "safe",
        "requires_target": True,
        "label": "Redémarrer",
        "description": "Redémarrer un container Docker",
    },
    "stop_container": {
        "func": stop_container,
        "risk_level": "moderate",
        "requires_target": True,
        "label": "Arrêter",
        "description": "Arrêter un container Docker",
    },
    "start_container": {
        "func": start_container,
        "risk_level": "safe",
        "requires_target": True,
        "label": "Démarrer",
        "description": "Démarrer un container Docker arrêté",
    },
    "get_container_status": {
        "func": get_container_status,
        "risk_level": "safe",
        "requires_target": True,
        "label": "Statut",
        "description": "Obtenir le statut détaillé d'un container",
    },
    "get_container_logs": {
        "func": get_container_logs,
        "risk_level": "safe",
        "requires_target": True,
        "label": "Logs",
        "description": "Consulter les logs récents d'un container",
    },
    "list_project_containers": {
        "func": list_project_containers,
        "risk_level": "safe",
        "requires_target": False,
        "label": "Lister containers",
        "description": "Lister tous les containers d'un projet compose",
    },
    "celery_ping": {
        "func": celery_ping,
        "risk_level": "safe",
        "requires_target": True,
        "label": "Ping worker",
        "description": "Envoyer un ping aux workers Celery",
    },
    "celery_active": {
        "func": celery_active,
        "risk_level": "safe",
        "requires_target": True,
        "label": "Tâches actives",
        "description": "Afficher les tâches Celery en cours d'exécution",
    },
    "celery_shutdown": {
        "func": celery_shutdown,
        "risk_level": "moderate",
        "requires_target": True,
        "label": "Arrêt gracieux",
        "description": "Arrêter gracieusement un worker Celery (redémarrage auto via Docker)",
    },
    "reload_nginx": {
        "func": reload_nginx,
        "risk_level": "safe",
        "requires_target": False,
        "label": "Recharger nginx",
        "description": "Recharger la configuration nginx (zéro downtime)",
    },
    "get_system_info": {
        "func": get_system_info,
        "risk_level": "safe",
        "requires_target": False,
        "label": "Infos système",
        "description": "Informations système: uptime, Docker, etc.",
    },
}


def execute_action(action_key: str, target: str = "", **kwargs) -> dict:
    """Execute a registered action by key."""
    if action_key not in ACTIONS:
        return {"success": False, "error": f"Action inconnue: {action_key}"}

    action_def = ACTIONS[action_key]
    func = action_def["func"]

    try:
        if action_def["requires_target"]:
            return func(target, **kwargs)
        return func(**kwargs)
    except Exception as e:
        return {"success": False, "error": str(e)[:500]}
