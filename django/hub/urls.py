"""Routes de l'API cliente /v1."""
from django.urls import path

from .api_views import ConnectionDetailView, ConnectionsView, MessagesView

urlpatterns = [
    path("v1/messages", MessagesView.as_view(), name="v1-messages"),
    path("v1/connections", ConnectionsView.as_view(), name="v1-connections"),
    path("v1/connections/<str:connection_id>", ConnectionDetailView.as_view(), name="v1-connection-detail"),
]
