'use strict';

/**
 * State machine explicite des statuts de message (Task 4).
 *
 * Corrige le point P0 identifié dans l'AUDIT.md : le bridge deskassit n'écoute jamais
 * `messages.update` — un message passe PENDING→SENT et rien de plus n'est jamais suivi.
 * Ici, chaque transition est un événement horodaté stocké séparément (voir schema.sql,
 * table messages_status), jamais un simple champ écrasé.
 *
 * Transitions valides :
 *   sent      -> delivered
 *   sent      -> failed
 *   sent      -> read        (WhatsApp peut regrouper delivered+read très rapidement)
 *   delivered -> read
 *   delivered -> failed
 *   failed    -> retry
 *   retry     -> sent
 *
 * Toute autre transition (ex. read -> sent, delivered -> sent) est invalide et rejetée
 * explicitement plutôt que silencieusement acceptée.
 */

const VALID_TRANSITIONS = {
  sent: ['delivered', 'failed', 'read'],
  delivered: ['read', 'failed'],
  read: [],
  failed: ['retry'],
  retry: ['sent'],
};

const ALL_STATUSES = Object.keys(VALID_TRANSITIONS);

function isValidStatus(status) {
  return ALL_STATUSES.includes(status);
}

/**
 * Vérifie si la transition from -> to est autorisée.
 */
function isValidTransition(from, to) {
  if (!isValidStatus(from) || !isValidStatus(to)) return false;
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Calcule le prochain statut pour un message, en fonction de son statut actuel et
 * de la transition demandée. Lève une erreur explicite si la transition est invalide,
 * plutôt que de l'accepter silencieusement.
 *
 * @param {string|null} currentStatus - Statut actuel (null si le message n'a pas encore de statut).
 * @param {string} nextStatus - Statut demandé.
 */
function transition(currentStatus, nextStatus) {
  if (!isValidStatus(nextStatus)) {
    throw new Error(`Statut inconnu : "${nextStatus}"`);
  }
  // Premier statut d'un message (généralement 'sent') : toujours autorisé.
  if (currentStatus === null || currentStatus === undefined) {
    return nextStatus;
  }
  if (!isValidTransition(currentStatus, nextStatus)) {
    throw new Error(`Transition invalide : "${currentStatus}" -> "${nextStatus}"`);
  }
  return nextStatus;
}

/**
 * Traduit un statut Baileys brut (issu de messages.update) vers un statut de la state
 * machine. Baileys utilise des codes numériques (WAMessageStatus) : ERROR=0, PENDING=1,
 * SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5.
 */
function fromBaileysStatusCode(code) {
  switch (code) {
    case 0: return 'failed';
    case 2: return 'sent'; // reçu par le serveur WhatsApp
    case 3: return 'delivered';
    case 4:
    case 5: return 'read';
    default: return null; // code inconnu ou non pertinent (ex. PENDING=1, déjà géré à l'envoi)
  }
}

module.exports = {
  VALID_TRANSITIONS,
  ALL_STATUSES,
  isValidStatus,
  isValidTransition,
  transition,
  fromBaileysStatusCode,
};
