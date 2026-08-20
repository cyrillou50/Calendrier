#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Diagnostic : pourquoi certbot n'obtient-il pas de certificat ?
#
#   sudo bash diagnostic-https.sh api.mondomaine.fr
#
# Teste dans l'ordre les 6 causes possibles et désigne la bonne.
# Ne modifie rien (hors un fichier de test supprimé à la fin).
# ═══════════════════════════════════════════════════════════
set -uo pipefail

DOMAINE="${1:-}"
[[ -n "$DOMAINE" ]] || { echo "Usage : sudo bash diagnostic-https.sh <domaine>"; exit 1; }

rouge() { printf '\033[31m  ✖ %s\033[0m\n' "$*"; }
vert()  { printf '\033[32m  ✔ %s\033[0m\n' "$*"; }
jaune() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
titre() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }

command -v dig >/dev/null || apt-get install -y -qq dnsutils >/dev/null 2>&1
VERDICT=""

# ─────────────────────────────────────────────────────────
titre "1 · Adresses IP de ce serveur"
IP4="$(curl -4 -s --max-time 6 https://api.ipify.org 2>/dev/null || true)"
IP6="$(curl -6 -s --max-time 6 https://api6.ipify.org 2>/dev/null || true)"
echo "     IPv4 : ${IP4:-aucune}"
echo "     IPv6 : ${IP6:-aucune}"

# ─────────────────────────────────────────────────────────
titre "2 · Ce que dit le DNS pour $DOMAINE"
A="$(dig +short A "$DOMAINE" | grep -E '^[0-9.]+$' | tail -1)"
AAAA="$(dig +short AAAA "$DOMAINE" | grep -E '^[0-9a-f:]+$' | tail -1)"
echo "     A    : ${A:-aucun}"
echo "     AAAA : ${AAAA:-aucun}"

if [[ -z "$A" && -z "$AAAA" ]]; then
  rouge "Le domaine ne résout vers rien. Crée un enregistrement A vers $IP4."
  VERDICT="DNS_ABSENT"
elif [[ -n "$A" && "$A" == "$IP4" ]]; then
  vert "L'enregistrement A pointe bien vers ce serveur."
elif [[ -n "$A" ]]; then
  rouge "L'enregistrement A pointe vers $A, or ce serveur est $IP4."
  VERDICT="DNS_MAUVAIS"
fi

# Cause classique : un AAAA orphelin. Let's Encrypt privilégie l'IPv6
# et échoue sans jamais essayer l'IPv4.
if [[ -n "$AAAA" && "$AAAA" != "$IP6" ]]; then
  rouge "L'enregistrement AAAA pointe vers $AAAA, qui n'est pas ce serveur."
  jaune "Let's Encrypt essaie l'IPv6 EN PRIORITÉ : il échouera sans tester l'IPv4."
  jaune "Solution : supprime l'enregistrement AAAA chez ton registraire."
  VERDICT="AAAA_ORPHELIN"
fi

# ─────────────────────────────────────────────────────────
titre "3 · Le domaine passe-t-il par un proxy (Cloudflare) ?"
NS="$(dig +short NS "${DOMAINE#*.}" | tr '\n' ' ')"
echo "     Serveurs de noms : ${NS:-inconnus}"
if echo "$A" | grep -qE '^(104\.(1[6-9]|2[0-9]|3[01])\.|172\.6[4-9]\.|172\.7[0-1]\.|188\.114\.|162\.15[89]\.|198\.41\.)'; then
  rouge "L'IP appartient à Cloudflare : le domaine est proxifié (nuage orange)."
  jaune "Let's Encrypt valide alors Cloudflare, pas ton VPS."
  jaune "Solution : passe l'enregistrement en DNS only (nuage gris), obtiens le"
  jaune "certificat, puis réactive le proxy si tu y tiens."
  VERDICT="CLOUDFLARE"
else
  vert "Pas de proxy Cloudflare détecté sur cet enregistrement."
fi

# ─────────────────────────────────────────────────────────
titre "4 · Nginx écoute-t-il sur le port 80 ?"
if ss -tlnH 'sport = :80' 2>/dev/null | grep -q .; then
  vert "Un service écoute bien sur le port 80."
  ss -tlnpH 'sport = :80' 2>/dev/null | sed 's/^/       /'
else
  rouge "Rien n'écoute sur le port 80 — certbot ne peut pas être validé."
  VERDICT="PORT80_FERME"
fi
nginx -t 2>&1 | sed 's/^/       /'

# ─────────────────────────────────────────────────────────
titre "5 · Test réel du défi ACME"
# C'est LE test décisif : il reproduit exactement ce que fait Let's Encrypt.
mkdir -p /var/www/html/.well-known/acme-challenge
JETON="calendrier-test-$$"
echo "$JETON" > "/var/www/html/.well-known/acme-challenge/$JETON"
chmod 644 "/var/www/html/.well-known/acme-challenge/$JETON"

echo "     Depuis le serveur lui-même :"
LOCAL="$(curl -s --max-time 8 -H "Host: $DOMAINE" \
        "http://127.0.0.1/.well-known/acme-challenge/$JETON" 2>/dev/null)"
if [[ "$LOCAL" == "$JETON" ]]; then
  vert "Nginx sert correctement le dossier de validation."
else
  rouge "Nginx ne sert pas /.well-known/acme-challenge/ (réponse : « ${LOCAL:0:60} »)"
  VERDICT="${VERDICT:-NGINX_CHEMIN}"
fi

echo "     Depuis l'extérieur (comme Let's Encrypt) :"
EXTERNE="$(curl -s --max-time 12 \
          "http://$DOMAINE/.well-known/acme-challenge/$JETON" 2>/dev/null)"
if [[ "$EXTERNE" == "$JETON" ]]; then
  vert "Le défi est accessible depuis Internet. Le HTTP-01 doit fonctionner."
else
  rouge "Inaccessible depuis l'extérieur (réponse : « ${EXTERNE:0:60} »)"
  jaune "Port 80 filtré par le pare-feu de ton hébergeur, ou DNS incorrect."
  VERDICT="${VERDICT:-EXTERIEUR_BLOQUE}"
fi
rm -f "/var/www/html/.well-known/acme-challenge/$JETON"

# ─────────────────────────────────────────────────────────
titre "6 · Limite de Let's Encrypt"
if [[ -f /var/log/letsencrypt/letsencrypt.log ]]; then
  ECHECS="$(grep -c 'too many failed authorizations\|rateLimited' \
           /var/log/letsencrypt/letsencrypt.log 2>/dev/null || echo 0)"
  if [[ "$ECHECS" -gt 0 ]]; then
    rouge "Tu as atteint la limite de tentatives (5 échecs par heure)."
    jaune "Attends une heure, ou teste d'abord avec --dry-run (illimité)."
    VERDICT="${VERDICT:-RATE_LIMIT}"
  else
    vert "Aucune limite atteinte."
  fi
  echo "     Dernière erreur enregistrée :"
  grep -i 'error\|detail:' /var/log/letsencrypt/letsencrypt.log 2>/dev/null \
    | tail -4 | sed 's/^/       /'
fi

# ─────────────────────────────────────────────────────────
titre "Verdict"
case "$VERDICT" in
  DNS_ABSENT)      rouge "Crée l'enregistrement A : $DOMAINE -> $IP4" ;;
  DNS_MAUVAIS)     rouge "Corrige l'enregistrement A : il doit valoir $IP4" ;;
  AAAA_ORPHELIN)   rouge "Supprime l'enregistrement AAAA de $DOMAINE" ;;
  CLOUDFLARE)      rouge "Désactive le proxy Cloudflare (nuage gris) pour $DOMAINE" ;;
  PORT80_FERME)    rouge "Ouvre le port 80 et démarre nginx" ;;
  NGINX_CHEMIN)    rouge "Nginx ne sert pas le dossier de validation" ;;
  EXTERIEUR_BLOQUE) rouge "Le port 80 est filtré depuis Internet (pare-feu hébergeur)" ;;
  RATE_LIMIT)      rouge "Limite Let's Encrypt atteinte — attends une heure" ;;
  "")              vert  "Tout est correct. Lance :"
                   echo  "       certbot --nginx -d $DOMAINE --dry-run"
                   echo  "       puis, si le test passe :"
                   echo  "       certbot --nginx -d $DOMAINE" ;;
esac
echo
