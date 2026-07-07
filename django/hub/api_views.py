"""API cliente /v1 (authentifiee par cle API, scoping strict au profil).

Replique les contrats du Node (src/app.js) : POST /v1/messages, GET /v1/connections,
GET /v1/connections/<id>. La resolution de connexion (par connection_id ou par channel)
est identique ; l'envoi est delegue au worker Node.
"""
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import worker_client
from .authentication import ApiKeyAuthentication
from .models import Connection
from .serializers import ConnectionSerializer


class _ApiView(APIView):
    authentication_classes = [ApiKeyAuthentication]
    permission_classes = [IsAuthenticated]


class MessagesView(_ApiView):
    def post(self, request):
        profile = request.user.profile
        data = request.data if isinstance(request.data, dict) else {}
        to = data.get("to")
        text = data.get("text")
        connection_id = data.get("connection_id")
        channel = data.get("channel")

        if not to or not text:
            return Response({"error": "missing_fields", "message": "to et text sont requis"}, status=400)

        owned = Connection.objects.filter(profile=profile)
        if connection_id:
            target = owned.filter(connection_id=connection_id).first()
            if target is None:
                return Response({"error": "connection_not_found",
                                 "message": "Connexion inconnue pour ce profil"}, status=404)
            if channel and target.channel_type != channel:
                return Response({"error": "channel_mismatch",
                                 "message": f'La connexion "{connection_id}" n\'est pas du canal "{channel}"'},
                                status=400)
        else:
            candidates = list(owned.filter(channel_type=channel) if channel else owned)
            if not candidates:
                return Response({"error": "connection_not_found",
                                 "message": (f'Aucune connexion de canal "{channel}" pour ce profil'
                                             if channel else "Aucune connexion pour ce profil")}, status=404)
            if len(candidates) > 1:
                return Response({"error": ("ambiguous_connection" if channel else "channel_required"),
                                 "message": (f'Plusieurs connexions de canal "{channel}" : precisez connection_id'
                                             if channel else "Plusieurs connexions : precisez channel (ou connection_id)")},
                                status=400)
            target = candidates[0]

        try:
            result = worker_client.send_message(target, to, text)
        except worker_client.ConnectionNotActive as exc:
            return Response({"error": "connection_not_active", "message": str(exc)}, status=409)
        except worker_client.WorkerUnavailable as exc:
            return Response({"error": "worker_unavailable", "message": str(exc)}, status=503)
        except worker_client.WorkerError as exc:
            return Response({"error": "worker_error", "message": str(exc)}, status=502)

        payload = dict(result) if isinstance(result, dict) else {"result": result}
        payload.update({"connectionId": target.connection_id, "channel": target.channel_type})
        return Response(payload, status=200)


class ConnectionsView(_ApiView):
    def get(self, request):
        rows = Connection.objects.filter(profile=request.user.profile).order_by("connection_id")
        return Response({"connexions": ConnectionSerializer(rows, many=True).data})


class ConnectionDetailView(_ApiView):
    def get(self, request, connection_id):
        row = Connection.objects.filter(profile=request.user.profile, connection_id=connection_id).first()
        if row is None:
            return Response({"error": "connection_not_found"}, status=404)
        return Response(ConnectionSerializer(row).data)
