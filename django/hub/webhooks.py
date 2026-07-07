"""Signature HMAC-SHA256 des webhooks sortants (parite avec src/webhook-signer.js du Node).

Signature au format "sha256=<hex>". Le payload est serialise en JSON compact (sans espaces,
unicode conserve) ; Django signe EXACTEMENT les octets qu'il transmet comme corps HTTP, donc
le client verifie le HMAC sur le corps brut recu (methode inchangee cote client).
"""
import hashlib
import hmac
import json


def _serialize(payload):
    if isinstance(payload, str):
        return payload
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def sign(payload, secret):
    """Signe le payload avec le secret. Retourne 'sha256=<hex>'. Leve si secret vide."""
    if not secret:
        raise ValueError("Secret HMAC requis pour signer un webhook")
    mac = hmac.new(secret.encode("utf-8"), _serialize(payload).encode("utf-8"), hashlib.sha256)
    return "sha256=" + mac.hexdigest()


def verify(payload, secret, signature):
    """Verifie une signature recue (comparaison a temps constant)."""
    if not signature or not isinstance(signature, str):
        return False
    try:
        expected = sign(payload, secret)
    except ValueError:
        return False
    return hmac.compare_digest(expected, signature)
