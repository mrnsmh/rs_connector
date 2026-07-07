"""Generation et hachage des cles API (parite avec src/api-key.js du Node).

Format : "dk_" + 32 octets aleatoires en base64url (sans padding).
On ne stocke JAMAIS la cle en clair : seulement son hash SHA-256 (hex) + un prefixe
visible (12 premiers caracteres) pour l'identifier dans l'admin.
"""
import base64
import hashlib
import secrets

API_KEY_PREFIX = "dk_"
VISIBLE_PREFIX_LENGTH = 12


def hash_api_key(api_key):
    """Hash SHA-256 (hex) deterministe d'une cle API."""
    return hashlib.sha256(str(api_key).encode("utf-8")).hexdigest()


def _random_b64url_32():
    # base64url SANS padding, comme crypto.randomBytes(32).toString('base64url') du Node.
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")


def generate_api_key():
    """Retourne {api_key, prefix, hash}. api_key = a montrer UNE fois, jamais stocke tel quel."""
    api_key = API_KEY_PREFIX + _random_b64url_32()
    return {
        "api_key": api_key,
        "prefix": api_key[:VISIBLE_PREFIX_LENGTH],
        "hash": hash_api_key(api_key),
    }


def generate_webhook_secret():
    """Secret HMAC de webhook (revele une fois, stocke tel quel), prefixe whsec_."""
    return "whsec_" + _random_b64url_32()
