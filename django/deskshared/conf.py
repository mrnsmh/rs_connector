"""Configuration for deskshared with sane defaults.

Every setting uses getattr(settings, KEY, default) so backends need ZERO
configuration unless they want to override a default.
"""

from django.conf import settings


class DeskSharedSettings:
    """Central configuration for deskshared."""

    @property
    def PROJECT_NAME(self) -> str:
        return getattr(settings, "DESKSHARED_PROJECT_NAME", getattr(settings, "PRODUCT_NAME", "desk"))

    @property
    def PROJECT_KEY(self) -> str:
        """Key used to identify this project in COMPOSE_PROJECTS, SERVICE_URLS, etc.

        Must match a key in COMPOSE_PROJECTS. Defaults to 'deskassit'."""
        return getattr(settings, "DESKSHARED_PROJECT_KEY", "deskassist")

    @property
    def HEALTH_CHECK_INTERVAL(self) -> int:
        """Seconds between automatic health snapshots (Celery beat)."""
        return getattr(settings, "DESKSHARED_HEALTH_INTERVAL", 300)

    @property
    def HISTORY_RETENTION_DAYS(self) -> int:
        """How many days of health snapshots to keep. 0 = forever."""
        return getattr(settings, "DESKSHARED_HISTORY_RETENTION_DAYS", 0)

    @property
    def ACTIONS_ENABLED(self) -> bool:
        """Whether restart/control actions are enabled."""
        return getattr(settings, "DESKSHARED_ACTIONS_ENABLED", True)

    @property
    def DOCKER_SOCKET(self) -> str:
        """Path to Docker socket for container management."""
        return getattr(settings, "DESKSHARED_DOCKER_SOCKET", "unix:///var/run/docker.sock")

    @property
    def COMPOSE_PROJECTS(self) -> dict:
        """Map of project key → docker compose project name.

        Example:
            {
                "deskassist": "desklink",
                "desklink": "desklink-backend",
                "studio": "desklink-studio",
                "rs_connector": "rs-connector",
                "immo": "deploy",
            }
        """
        return getattr(settings, "DESKSHARED_COMPOSE_PROJECTS", {
            "deskassist": "desklink",
            "desklink": "desklink-backend",
            "studio": "desklink-studio",
            "rs_connector": "rs-connector",
            "immo": "deploy",
        })

    @property
    def SERVICE_URLS(self) -> dict:
        """Map of project key → health endpoint URL for cross-service checks."""
        return getattr(settings, "DESKSHARED_SERVICE_URLS", {
            "deskassist": "http://127.0.0.1:8000",
            "desklink": "http://127.0.0.1:8010",
            "studio": "http://127.0.0.1:8020",
            "rs_connector": "http://127.0.0.1:3019",
            "immo": "http://127.0.0.1:8030",
        })

    @property
    def NOTIFICATION_CHANNELS(self) -> list:
        """Available notification channels: 'in_app', 'email', 'telegram', 'slack'."""
        return getattr(settings, "DESKSHARED_NOTIFICATION_CHANNELS", ["in_app"])

    @property
    def CELERY_TASK_QUEUE(self) -> str:
        """Queue name for health check tasks."""
        return getattr(settings, "DESKSHARED_CELERY_QUEUE", "default")


deskshared_settings = DeskSharedSettings()
