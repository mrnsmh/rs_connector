"""Models for deskshared health monitoring and action logging."""

from django.conf import settings
from django.db import models


class HealthSnapshot(models.Model):
    """A health snapshot at a point in time.

    Stores the full check results for historical analysis.
    Created automatically by the Celery periodic task or on-demand.
    """

    class Overall(models.TextChoices):
        OK = "ok", "OK"
        WARN = "warn", "Warning"
        ERROR = "error", "Error"

    id = models.BigAutoField(primary_key=True)
    project = models.CharField(
        max_length=50,
        db_index=True,
        help_text="Project key: deskassit, desklink, studio, rs_connector, immo",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    overall = models.CharField(max_length=10, choices=Overall.choices)
    checks = models.JSONField(
        help_text="Full payload of health checks at this snapshot",
    )
    system_info = models.JSONField(
        default=dict,
        blank=True,
        help_text="System info: uptime, python version, cpu, memory, etc.",
    )

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Health Snapshot"
        verbose_name_plural = "Health Snapshots"

    def __str__(self):
        return f"[{self.project}] {self.overall} @ {self.created_at:%Y-%m-%d %H:%M}"


class ActionLog(models.Model):
    """Log of an action performed from the diagnostic dashboard."""

    class RiskLevel(models.TextChoices):
        SAFE = "safe", "Safe"
        MODERATE = "moderate", "Moderate"
        DANGEROUS = "dangerous", "Dangerous"

    id = models.BigAutoField(primary_key=True)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="deskshared_actions",
    )
    project = models.CharField(max_length=50, db_index=True)
    action = models.CharField(
        max_length=100,
        help_text="Action type: restart_container, reload_nginx, celery_ping, etc.",
    )
    target = models.CharField(
        max_length=200,
        help_text="Target: container name, service, etc.",
    )
    risk_level = models.CharField(
        max_length=10,
        choices=RiskLevel.choices,
        default=RiskLevel.SAFE,
    )
    result = models.JSONField(
        default=dict,
        blank=True,
        help_text="Command output: stdout, exit_code, success, duration_ms",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Action Log"
        verbose_name_plural = "Action Logs"

    def __str__(self):
        return f"[{self.project}] {self.action} → {self.target} @ {self.created_at:%H:%M}"


class NotificationPreference(models.Model):
    """Per-user notification preferences for health alerts."""

    class Channel(models.TextChoices):
        IN_APP = "in_app", "In-App"
        EMAIL = "email", "Email"
        TELEGRAM = "telegram", "Telegram"
        SLACK = "slack", "Slack"

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="deskshared_notifications",
    )
    channel = models.CharField(
        max_length=20,
        choices=Channel.choices,
        default=Channel.IN_APP,
    )
    notify_on_error = models.BooleanField(default=True)
    notify_on_recovery = models.BooleanField(default=True)
    notify_on_action_failed = models.BooleanField(default=True)
    telegram_chat_id = models.CharField(max_length=100, blank=True, default="")
    slack_webhook_url = models.URLField(blank=True, default="")
    email_address = models.EmailField(blank=True, default="")

    class Meta:
        verbose_name = "Notification Preference"
        verbose_name_plural = "Notification Preferences"

    def __str__(self):
        return f"{self.user} → {self.channel}"
