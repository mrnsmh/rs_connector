"""Celery tasks for deskshared health monitoring."""

import logging

from celery import shared_task

logger = logging.getLogger("deskshared")


@shared_task(name="deskshared.collect_health_snapshot")
def collect_health_snapshot():
    """Collect a health snapshot and store it in the database.

    Called periodically by Celery beat (every 5 min by default).
    Also called on-demand via the API.
    """
    from .checks import compute_overall, run_all_checks
    from .conf import deskshared_settings
    from .models import HealthSnapshot

    project = deskshared_settings.PROJECT_KEY
    checks = run_all_checks()
    overall = compute_overall(checks)

    # Extract system info from checks
    system_info = {}
    system_check = next((c for c in checks if c["key"] == "system"), None)
    if system_check and "system" in system_check:
        system_info = system_check["system"]

    snapshot = HealthSnapshot.objects.create(
        project=project,
        overall=overall,
        checks=checks,
        system_info=system_info,
    )

    # Clean old snapshots if retention is configured
    retention = deskshared_settings.HISTORY_RETENTION_DAYS
    if retention > 0:
        from django.utils import timezone
        import datetime
        cutoff = timezone.now() - datetime.timedelta(days=retention)
        old_count = HealthSnapshot.objects.filter(
            created_at__lt=cutoff,
        ).delete()[0]
        if old_count:
            logger.info("Cleaned %d old health snapshots", old_count)

    # Send notifications on error
    if overall == "error":
        _send_error_notification(project, checks)

    return {
        "snapshot_id": snapshot.id,
        "project": project,
        "overall": overall,
        "checks_count": len(checks),
    }


def _send_error_notification(project: str, checks: list):
    """Send in-app notification when health check fails."""
    try:
        from .models import NotificationPreference

        error_checks = [c for c in checks if c["status"] == "error"]
        if not error_checks:
            return

        down_labels = ", ".join(c["label"] for c in error_checks)

        # Get superusers to notify
        from django.contrib.auth import get_user_model
        User = get_user_model()
        superusers = User.objects.filter(is_superuser=True, is_active=True)

        for user in superusers:
            # Check user preferences
            try:
                pref = NotificationPreference.objects.get(user=user)
                if not pref.notify_on_error:
                    continue
            except NotificationPreference.DoesNotExist:
                pass  # Default: notify

            # Create in-app notification
            try:
                from apps.alerts.models import Notification
                if not Notification.objects.filter(
                    user=user,
                    event="deskshared_health",
                    read_at__isnull=True,
                ).exists():
                    Notification.objects.create(
                        user=user,
                        event="deskshared_health",
                        title=f"Problème système détecté ({project})",
                        message=f"Composant(s) en panne : {down_labels}",
                        url="/diagnostic",
                    )
            except (ImportError, Exception) as e:
                logger.warning("Failed to create in-app notification: %s", e)
    except Exception as e:
        logger.warning("Failed to send error notification: %s", e)


def get_periodic_tasks() -> dict:
    """Return Celery beat schedule entries for deskshared.

    Merge into your CELERY_BEAT_SCHEDULE:
        from deskshared.tasks import get_periodic_tasks
        CELERY_BEAT_SCHEDULE.update(get_periodic_tasks())
    """
    from .conf import deskshared_settings
    return {
        "deskshared-health-snapshot": {
            "task": "deskshared.collect_health_snapshot",
            "schedule": deskshared_settings.HEALTH_CHECK_INTERVAL,
        },
    }
