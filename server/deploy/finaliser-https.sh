#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Finalise Nginx + HTTPS pour l'API Calendrier.
#
#   sudo bash finaliser-https.sh api.mondomaine.fr
#
# Reconstruit la configuration Nginx, vérifie que le défi ACME
# passe DEPUIS INTERNET, puis seulement lance certbot.
# S'arrête proprement à la première anomalie, sans jamais
# perturber les autres sites du serveur.
# ═══════════════════════════════════════════════════════════
set -uo pipefail

D="${1:-}"
[[ -n "$D" ]] || { echo "Usage : sudo bash finaliser-https.sh <domaine>"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "À lancer avec sudo."; exit 1; }

CONF=/etc/nginx/sites-available/calendrier-api
LIEN=/etc/nginx/sites-enabled/calendrier-api

rouge() { printf '\033[31m  ✖ %s\033[0m\n' "$*"; }
vert()  { printf '\033[32m  ✔ %s\033[0m\n' "$*"; }
jaune() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
titre() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }

# ─────────────────────────────────────────────────────────
titre "1/6 · L'API répond-elle en local ?"
PORT="$(grep -oP '^PORT=\K[0-9]+' /opt/calendrier/server/.env 2>/dev/null || echo 8787)"
echo "     port configuré : $PORT"

if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  vert "l'API répond sur 127.0.0.1:$PORT"
else
  rouge "l'API ne répond pas sur 127.0.0.1:$PORT"
  systemctl status calendrier-api --no-pager -l 2>/dev/null | tail -15
  echo
  rouge "Corrige d'abord l'API, le HTTPS n'a pas de sens sans elle."
  exit 1
fi

# ─────────────────────────────────────────────────────────
titre "2/6 · Le DNS pointe-t-il vers ce serveur ?"
command -v dig >/dev/null || apt-get install -y -qq dnsutils >/dev/null 2>&1
IP4="$(curl -4 -s --max-time 6 https://api.ipify.org 2>/dev/null)"
A="$(dig +short A "$D" | grep -E '^[0-9.]+$' | tail -1)"
AAAA="$(dig +short AAAA "$D" | grep -E '^[0-9a-f:]+$' | tail -1)"

echo "     IPv4 du serveur : ${IP4:-inconnue}"
echo "     A    du domaine : ${A:-aucun}"
echo "     AAAA du domaine : ${AAAA:-aucun}"

if [[ -z "$A" ]]; then
  rouge "Aucun enregistrement A. Crée : $D  ->  $IP4"
  exit 1
elif [[ "$A" != "$IP4" ]]; then
  rouge "Le A pointe vers $A, mais ce serveur est $IP4."
  exit 1
else
  vert "l'enregistrement A est correct"
fi

if [[ -n "$AAAA" ]]; then
  jaune "Un enregistrement AAAA existe ($AAAA)."
  jaune "Let's Encrypt teste l'IPv6 EN PRIORITÉ. Si cette adresse n'est pas"
  jaune "ce serveur, la validation échouera sans jamais essayer l'IPv4."
  jaune "En cas d'échec plus bas : supprime ce AAAA chez ton registraire."
fi

# ─────────────────────────────────────────────────────────
titre "3/6 · Configuration Nginx (HTTP seul)"
# On repart d'une base saine : certbot ajoutera lui-même le bloc HTTPS.
rm -f "$LIEN"

cat > "$CONF" <<EOF
# Généré par finaliser-https.sh — certbot complétera ce fichier.
limit_req_zone \$binary_remote_addr zone=calendrier_auth:10m rate=10r/m;
limit_req_zone \$binary_remote_addr zone=calendrier_api:10m  rate=120r/m;

server {
    listen 80;
    listen [::]:80;
    server_name $D;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;

    client_max_body_size 10m;
    access_log /var/log/nginx/calendrier-access.log;
    error_log  /var/log/nginx/calendrier-error.log;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type "text/plain";
    }

    location /api/auth/ {
        limit_req zone=calendrier_auth burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /api/ {
        limit_req zone=calendrier_api burst=40 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    location / { return 404; }
}
EOF

ln -sf "$CONF" "$LIEN"

if nginx -t 2>/tmp/nginx-t.log; then
  vert "configuration valide"
else
  rouge "configuration invalide :"
  sed 's/^/       /' /tmp/nginx-t.log
  rm -f "$LIEN"
  rouge "Lien retiré — tes autres sites ne sont pas affectés."
  exit 1
fi
systemctl reload nginx && vert "nginx rechargé"

# ─────────────────────────────────────────────────────────
titre "4/6 · Le défi ACME passe-t-il depuis Internet ?"
# Test décisif : on reproduit exactement ce que fera Let's Encrypt.
mkdir -p /var/www/html/.well-known/acme-challenge
JETON="calendrier-$$"
echo "$JETON" > "/var/www/html/.well-known/acme-challenge/$JETON"
chmod 644 "/var/www/html/.well-known/acme-challenge/$JETON"

REPONSE="$(curl -s --max-time 15 "http://$D/.well-known/acme-challenge/$JETON" 2>/dev/null)"
rm -f "/var/www/html/.well-known/acme-challenge/$JETON"

if [[ "$REPONSE" == "$JETON" ]]; then
  vert "le défi est accessible depuis Internet"
else
  rouge "défi inaccessible — réponse reçue : « ${REPONSE:0:80} »"
  echo
  jaune "Causes possibles, dans l'ordre de fréquence :"
  jaune "  1. Port 80 filtré par le pare-feu de ton hébergeur"
  jaune "  2. Un autre bloc nginx capte $D avant le nôtre :"
  nginx -T 2>/dev/null | grep -n "server_name" | grep -v "^\s*#" | head -12 | sed 's/^/         /'
  jaune "  3. Le domaine passe par un proxy (Cloudflare)"
  echo
  rouge "certbot échouerait — je m'arrête ici pour préserver ton quota."
  exit 1
fi

# ─────────────────────────────────────────────────────────
titre "5/6 · Répétition générale (certbot --dry-run)"
# Le serveur de test n'a aucune limite : on valide sans rien consommer.
if certbot certonly --nginx -d "$D" --dry-run --non-interactive \
     --agree-tos --register-unsafely-without-email 2>&1 | tail -8 | sed 's/^/     /'; then
  vert "la répétition a réussi"
else
  rouge "la répétition a échoué — erreur exacte :"
  grep -i "detail:" /var/log/letsencrypt/letsencrypt.log 2>/dev/null | tail -3 | sed 's/^/       /'
  exit 1
fi

# ─────────────────────────────────────────────────────────
titre "6/6 · Certificat définitif"
if certbot --nginx -d "$D" --non-interactive --agree-tos \
     --register-unsafely-without-email --redirect 2>&1 | tail -10 | sed 's/^/     /'; then
  vert "certificat installé"
else
  rouge "échec :"
  grep -i "detail:" /var/log/letsencrypt/letsencrypt.log 2>/dev/null | tail -3 | sed 's/^/       /'
  exit 1
fi

nginx -t >/dev/null 2>&1 && systemctl reload nginx

# ─────────────────────────────────────────────────────────
titre "Vérification finale"
SANTE="$(curl -s --max-time 10 "https://$D/api/health" 2>/dev/null)"
if echo "$SANTE" | grep -q '"ok":true'; then
  vert "https://$D/api/health répond :"
  echo "       $SANTE"
  echo
  vert "═══════════════════════════════════════════════"
  vert " Tout fonctionne."
  echo
  echo "  Sur ton site GitHub Pages, ouvre « Compte & sauvegarde »"
  echo "  et saisis :  https://$D"
  echo
  echo "  Le renouvellement du certificat est automatique."
  echo "  Vérifier :   certbot renew --dry-run"
  vert "═══════════════════════════════════════════════"
else
  rouge "HTTPS répond mal : « ${SANTE:0:120} »"
  jaune "L'API tourne pourtant en local. Regarde :"
  jaune "  tail -20 /var/log/nginx/calendrier-error.log"
  exit 1
fi
