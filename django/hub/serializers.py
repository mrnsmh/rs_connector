"""Serializers de l'API cliente."""
from rest_framework import serializers

from .models import Connection


class ConnectionSerializer(serializers.ModelSerializer):
    connectionId = serializers.CharField(source="connection_id")
    channelType = serializers.CharField(source="channel_type")

    class Meta:
        model = Connection
        fields = ["connectionId", "channelType", "status"]
