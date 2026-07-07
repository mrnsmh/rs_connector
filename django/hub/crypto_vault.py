"""Coffre AES-256-GCM COMPATIBLE avec le vault Node (src/crypto-vault.js).

Format identique, interoperable a l'octet pres :
    gcm1.<ivB64>.<tagB64>.<ciphertextB64>
IV = 12 octets aleatoires, tag GCM = 16 octets, chaque partie en base64, pas d'AAD.

La cle (32 octets) vient de CREDENTIALS_ENCRYPTION_KEY (base64 ou hex), la meme que
celle du Node, afin de pouvoir dechiffrer les credentials existants (ex. token tg-test).
"""
import base64
import binascii
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PREFIX = "gcm1"
IV_BYTES = 12
TAG_BYTES = 16


class VaultError(Exception):
    """Erreur de configuration de cle ou echec de dechiffrement (integrite/cle)."""


def normalize_key(key):
    """Retourne 32 octets. Accepte bytes(32) ou une chaine base64/hex (comme le Node)."""
    if isinstance(key, (bytes, bytearray)):
        if len(key) != 32:
            raise VaultError("La cle de chiffrement doit faire 32 octets")
        return bytes(key)
    if isinstance(key, str) and key:
        for decoder in (base64.b64decode, bytes.fromhex):
            try:
                buf = decoder(key)
            except (binascii.Error, ValueError):
                continue
            if len(buf) == 32:
                return buf
    raise VaultError("CREDENTIALS_ENCRYPTION_KEY invalide : 32 octets attendus (base64 ou hex)")


class Vault:
    def __init__(self, key):
        self._aead = AESGCM(normalize_key(key))

    def encrypt(self, plaintext):
        iv = os.urandom(IV_BYTES)
        # AESGCM.encrypt renvoie (ciphertext || tag) ; on isole le tag (16 derniers octets)
        # pour reproduire le format Node <iv>.<tag>.<ct>.
        blob = self._aead.encrypt(iv, str(plaintext).encode("utf-8"), None)
        ct, tag = blob[:-TAG_BYTES], blob[-TAG_BYTES:]
        return "{}.{}.{}.{}".format(
            PREFIX,
            base64.b64encode(iv).decode("ascii"),
            base64.b64encode(tag).decode("ascii"),
            base64.b64encode(ct).decode("ascii"),
        )

    def decrypt(self, payload):
        parts = str(payload).split(".")
        if len(parts) != 4 or parts[0] != PREFIX:
            raise VaultError("Format de chiffre invalide")
        try:
            iv = base64.b64decode(parts[1])
            tag = base64.b64decode(parts[2])
            ct = base64.b64decode(parts[3])
        except (binascii.Error, ValueError) as exc:
            raise VaultError("Format de chiffre invalide") from exc
        try:
            # On reconcatene ct || tag pour AESGCM.decrypt (integrite verifiee par GCM).
            plaintext = self._aead.decrypt(iv, ct + tag, None)
        except Exception as exc:  # InvalidTag ou autre
            raise VaultError("Dechiffrement echoue (integrite ou cle invalide)") from exc
        return plaintext.decode("utf-8")

    def encrypt_json(self, obj):
        # separators compacts + unicode conserve pour coller au JSON.stringify du Node.
        return self.encrypt(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))

    def decrypt_json(self, payload):
        return json.loads(self.decrypt(payload))


def generate_key():
    """Genere une cle de 32 octets en base64 (equivalent generateKey() du Node)."""
    return base64.b64encode(os.urandom(32)).decode("ascii")
