"""Django system checks for deskshared."""

from django.conf import settings
from django.core.checks import Warning, register


@register()
def check_celery_beat_schedule(app_configs, **kwargs):
    """Verify that deskshared periodic task is in CELERY_BEAT_SCHEDULE."""
    warnings = []
    beat_schedule = getattr(settings, "CELERY_BEAT_SCHEDULE", {})
    if "deskshared-health-snapshot" not in beat_schedule:
        warnings.append(
            Warning(
                "deskshared periodic task not in CELERY_BEAT_SCHEDULE",
                hint=(
                    "Add to your settings: "
                    "from deskshared.tasks import get_periodic_tasks; "
                    "CELERY_BEAT_SCHEDULE.update(get_periodic_tasks())"
                ),
                id="deskshared.W001",
            )
        )
    return warnings
