from django.apps import AppConfig


class DeskSharedConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "deskshared"
    verbose_name = "Desk Shared — Diagnostic & Health"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        import deskshared.system_checks  # noqa: F401 — register Django system checks
