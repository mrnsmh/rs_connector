"""Client HTTP vers le worker Node (adaptateurs de messagerie).

Django (plan de controle) delegue l'envoi sortant au worker Node, seul a detenir les
sessions live (Baileys, Telegram, Email, WhatsApp Cloud). Contrat interne finalise a l'etape 6 ;
ici on pose l'interface. Sans WORKER_URL configure, l'envoi renvoie worker_unavailable.
"""
import json
import os
import urllib.error
import urllib.request


class WorkerError(Exception):
    pass


class WorkerUnavailable(WorkerError):
    pass


class ConnectionNotActive(WorkerError):
    pass


def _base_url():
    return os.environ.get("WORKER_URL", "").rstrip("/")


def send_message(connection, to, text, timeout=15):
    """Demande au worker d'envoyer un message via la connexion donnee. Retourne le dict resultat."""
    base = _base_url()
    if not base:
        raise WorkerUnavailable("WORKER_URL non configure (worker Node indisponible)")
    payload = json.dumps({
        "connectionId": connection.connection_id,
        "profileId": str(connection.profile_id),
        "channelType": connection.channel_type,
        "to": to,
        "text": text,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/internal/send",
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Worker-Token": os.environ.get("WORKER_TOKEN", ""),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        if exc.code == 409:
            raise ConnectionNotActive("Connexion non active (aucune session en cours)")
        raise WorkerError(f"Worker a repondu HTTP {exc.code}")
    except urllib.error.URLError as exc:
        raise WorkerUnavailable(f"Worker injoignable ({exc.reason})")
