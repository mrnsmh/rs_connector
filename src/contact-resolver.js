'use strict';

/**
 * Contact Resolver (Task 5, corrigé après relecture critique post-implémentation).
 *
 * WhatsApp adresse souvent les expéditeurs par LID (identifiant de confidentialité,
 * ex. "139642322083882@lid") et non par leur numéro réel : envoyer à
 * "<lid>@s.whatsapp.net" OU "<lid>@lid" sans mapping résolu N'ATTEINT JAMAIS le client
 * dans le cas général — WhatsApp peut accepter l'envoi silencieusement (le statut
 * Baileys peut même remonter "delivered") sans que le message soit réellement livré
 * à un humain. C'est le bug diagnostiqué côté deskassit, et la version initiale de ce
 * module reproduisait le même risque via un repli silencieux vers `@lid`.
 *
 * CORRECTIF (voir SUIVI-AVANCEMENT.md, section "Task 5 rouverte") : ce module ne fait
 * plus JAMAIS de repli silencieux. Si le destinataire est un LID et qu'aucun mapping
 * fiable n'est trouvé (ni en cache DB, ni dans les fichiers d'auth Baileys), il lève
 * une erreur explicite `LidUnresolvedError` — c'est à l'appelant (session.js /
 * POST /v1/messages) de traduire cette erreur en réponse claire (422) plutôt que de
 * risquer un envoi fantôme silencieusement marqué "delivered".
 *
 * Le mapping résolu est mis en cache dans la DB du gateway (table `contacts`, voir
 * db.js) pour éviter de relire les fichiers d'auth à chaque envoi, et pour être
 * alimenté aussi par les messages ENTRANTS (Baileys fournit souvent le LID réel de
 * l'expéditeur dès messages.upsert — voir session.js).
 *
 * Trois cas couverts :
 *   1. mapping LID connu (cache DB, sinon fichier d'auth) -> résolution vers le vrai numéro
 *   2. mapping LID inconnu -> ERREUR EXPLICITE (LidUnresolvedError), plus de repli fantôme
 *   3. destinataire déjà un numéro/JID valide -> passthrough sans transformation
 */

/**
 * Erreur explicite levée quand un LID ne peut être résolu vers un numéro réel.
 * Doit être traduite en réponse HTTP 422 par l'appelant, jamais en 500 générique ni
 * en envoi silencieux vers un JID fantôme.
 */
class LidUnresolvedError extends Error {
  constructor(lid) {
    super(`Impossible de résoudre le LID "${lid}" vers un numéro réel : mapping absent (ni cache DB, ni fichier d'auth). Envoi bloqué pour éviter un message fantôme.`);
    this.name = 'LidUnresolvedError';
    this.lid = lid;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.fs - fs/promises (ou mock), pour lire le fichier de mapping.
 * @param {object} [deps.db] - Instance db.js (ou mock), pour le cache persistant du
 *   mapping LID->numéro (table `contacts`). Optionnel : si absent, seule la lecture du
 *   fichier d'auth est utilisée (comportement Task 5 initial, sans cache).
 * @param {string} authDir - Répertoire d'auth de la connexion (contient le mapping LID).
 * @param {string} [connectionId] - Identifiant connexion, nécessaire uniquement si `db` est fourni.
 */
function createContactResolver(deps, authDir, connectionId) {
  const { fs, db } = deps;

  async function readMappingFile(digits) {
    try {
      const raw = await fs.readFile(`${authDir}/lid-mapping-${digits}_reverse.json`, 'utf8');
      const phoneNumber = JSON.parse(raw);
      if (phoneNumber && /^[0-9]{6,}$/.test(String(phoneNumber))) {
        return String(phoneNumber);
      }
    } catch {
      // Fichier absent, JSON invalide, ou valeur non numérique -> pas de mapping fiable.
    }
    return null;
  }

  /**
   * Enregistre un mapping LID->numéro connu (ex. déduit d'un message entrant) dans le
   * cache DB, pour accélérer les résolutions futures sans relire de fichier.
   */
  async function learnMapping(lid, phoneNumber) {
    if (!db || !connectionId) return;
    try {
      await db.upsertContact({ connectionId, lid, phoneNumber });
    } catch {
      // Le cache est une optimisation, pas une source de vérité : un échec d'écriture
      // ne doit jamais interrompre le flux applicatif.
    }
  }

  /**
   * Résout un destinataire (numéro, JID ou LID) vers le JID d'envoi correct.
   * Lève `LidUnresolvedError` si le destinataire est un LID sans mapping connu.
   */
  async function resolve(to) {
    const s = String(to || '').trim();

    // Cas 3 : déjà un JID numéro valide — passthrough sans transformation.
    if (s.endsWith('@s.whatsapp.net')) return s;

    // Tout autre format déjà qualifié avec un suffixe explicite non-LID (ex. @g.us pour
    // un groupe) -> passthrough. Vérifié AVANT la détection LID, car un identifiant de
    // groupe contient souvent un tiret + beaucoup de chiffres qui pourrait sinon être
    // confondu avec un numéro LID une fois les caractères non numériques retirés.
    if (s.includes('@') && !s.endsWith('@lid')) return s;

    const digits = s.replace(/[^0-9]/g, '');
    const looksLid = s.endsWith('@lid') || digits.length >= 14;

    if (looksLid && digits) {
      // 1. Cache DB d'abord (rapide, pas de lecture disque).
      if (db && connectionId) {
        try {
          const cached = await db.getContact(connectionId, digits);
          if (cached && cached.phone_number) {
            return `${cached.phone_number}@s.whatsapp.net`;
          }
        } catch {
          // Le cache DB est indisponible -> on retombe sur la lecture fichier ci-dessous,
          // jamais sur un repli silencieux vers @lid.
        }
      }

      // 2. Fichier d'auth Baileys (source d'origine du mapping).
      const phoneNumber = await readMappingFile(digits);
      if (phoneNumber) {
        await learnMapping(digits, phoneNumber);
        return `${phoneNumber}@s.whatsapp.net`;
      }

      // CORRECTIF : plus de repli silencieux vers `${digits}@lid`. Un LID non résolu
      // doit bloquer l'envoi explicitement — pas produire un message fantôme marqué
      // "delivered" par erreur.
      throw new LidUnresolvedError(digits);
    }

    // Cas 3 (variante) : numéro brut sans suffixe -> on ajoute le suffixe standard.
    return `${digits}@s.whatsapp.net`;
  }

  return { resolve, learnMapping };
}

module.exports = { createContactResolver, LidUnresolvedError };
