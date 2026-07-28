"""Management command to run health checks manually."""

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Run deskshared health checks and display results"

    def add_arguments(self, parser):
        parser.add_argument(
            "--save",
            action="store_true",
            help="Save snapshot to database",
        )
        parser.add_argument(
            "--json",
            action="store_true",
            help="Output as JSON",
        )

    def handle(self, *args, **options):
        from deskshared.checks import compute_overall, run_all_checks

        checks = run_all_checks()
        overall = compute_overall(checks)

        if options["json"]:
            import json
            output = {
                "overall": overall,
                "checks": checks,
            }
            self.stdout.write(json.dumps(output, indent=2, ensure_ascii=False))
        else:
            self.stdout.write(f"\n{'='*60}")
            self.stdout.write(f"  DIAGNOSTIC SYSTÈME — {overall.upper()}")
            self.stdout.write(f"{'='*60}\n")

            for check in checks:
                status_icon = {"ok": "✅", "warn": "⚠️", "error": "❌"}.get(check["status"], "?")
                ms = f" ({check['ms']}ms)" if check.get("ms") else ""
                self.stdout.write(f"  {status_icon} {check['label']:<30} {check['detail']}{ms}")

                if check.get("diagnostic"):
                    diag = check["diagnostic"]
                    self.stdout.write(f"     → Cause: {diag['cause']}")
                    self.stdout.write(f"     → Fix:   {diag['fix']}")

            self.stdout.write(f"\n{'='*60}\n")

        if options["save"]:
            from deskshared.tasks import collect_health_snapshot
            result = collect_health_snapshot()
            self.stdout.write(f"Snapshot saved: {result}")
