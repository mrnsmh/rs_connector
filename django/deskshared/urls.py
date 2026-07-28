"""URL patterns for deskshared."""

from django.urls import path

from . import views

app_name = "deskshared"

urlpatterns = [
    # Health
    path("full/", views.HealthFullView.as_view(), name="health-full"),
    path("history/", views.HealthHistoryView.as_view(), name="health-history"),
    path("snapshot/", views.HealthSnapshotCreateView.as_view(), name="health-snapshot"),

    # Actions
    path("actions/", views.ActionsListView.as_view(), name="actions-list"),
    path("actions/execute/", views.ActionExecuteView.as_view(), name="actions-execute"),
    path("actions/history/", views.ActionHistoryView.as_view(), name="actions-history"),

    # Containers
    path("containers/", views.ContainerStatusView.as_view(), name="containers-status"),
    path("containers/logs/", views.ContainerLogsView.as_view(), name="containers-logs"),

    # Notification preferences
    path("notifications/preferences/", views.NotificationPreferencesView.as_view(), name="notification-prefs"),
]
