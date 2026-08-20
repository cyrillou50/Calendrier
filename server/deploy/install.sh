#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Installation de l'API Calendrier sur un VPS Debian/Ubuntu
#
#   sudo bash install.sh api.mondomaine.fr https://ton-pseudo.github.io
#
# Le script est idempotent : tu peux le relancer sans risque.
# ═══════════════════════════════════════════════════════════
set -euo pipefail

DOMAINE="${1:-}"
ORIGINE="${2:-}"
RACINE="/opt/calendrier"
UTILISATEUR="calendrier"

rouge()  { printf '\033[31m%s\033[0m\n' "$*"; }
vert()   { printf '\033[32m%s\033[0m\n' "$*"; }
titre()  { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  rouge "Ce script doit être lancé avec sudo."; exit 1
fi
if [[ -z "$DOMAINE" || -z "$ORIGINE" ]]; then
  rouge "Usage : sudo bash install.sh <domaine-api> <origine-github-pages>"
  echo   "Exemple : sudo bash install.sh api.mondomaine.fr https://cyril.github.io"
  exit 1
fi

titre "1/7 · Paquets système"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg nginx ufw >/dev/null
vert "  nginx et outils installés"

titre "2/7 · Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs build-essential >/dev/null
fi
vert "  $(node -v) / npm $(npm -v)"

titre "3/7 · Utilisateur et dossiers"
id -u "$UTILISATEUR" >/dev/null 2>&1 || useradd --system --home "$RACINE" --shell /usr/sbin/nologin "$UTILISATEUR"
mkdir -p "$RACINE" /var/backups/calendrier
# Copie les sources si le script est lancé depuis le dépôt cloné
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$SRC" != "$RACINE/server" ]]; then
  mkdir -p "$RACINE/server"
  cp -r "$SRC/src" "$SRC/package.json" "$RACINE/server/"
  [[ -d "$SRC/scripts" ]] && cp -r "$SRC/scripts" "$RACINE/server/"
  [[ -d "$SRC/deploy" ]]  && cp -r "$SRC/deploy"  "$RACINE/server/"
fi
vert "  sources déployées dans $RACINE/server"

titre "4/7 · Dépendances npm"
cd "$RACINE/server"
npm install --omit=dev --no-audit --no-fund
vert "  dépendances installées"

titre "5/7 · Fichier .env"
if [[ ! -f "$RACINE/server/.env" ]]; then
  cat > "$RACINE/server/.env" <<EOF
PORT=8787
HOST=127.0.0.1
ALLOWED_ORIGINS=${ORIGINE%/}
ALLOW_REGISTRATION=true
DATA_DIR=$RACINE/server/data
MAX_EVENTS_PER_USER=20000
EOF
  vert "  .env créé (origine autorisée : ${ORIGINE%/})"
else
  vert "  .env existant conservé"
fi
mkdir -p "$RACINE/server/data"
chown -R "$UTILISATEUR:$UTILISATEUR" "$RACINE" /var/backups/calendrier
chmod 600 "$RACINE/server/.env"

titre "6/7 · Service systemd"
sed "s|/opt/calendrier|$RACINE|g" "$RACINE/server/deploy/calendrier-api.service" \
  > /etc/systemd/system/calendrier-api.service
systemctl daemon-reload
systemctl enable --now calendrier-api
sleep 2
if systemctl is-active --quiet calendrier-api; then
  vert "  service actif sur 127.0.0.1:8787"
else
  rouge "  le service n'a pas démarré :"; journalctl -u calendrier-api -n 30 --no-pager; exit 1
fi

titre "7/7 · Nginx + certificat HTTPS"
sed "s|api.mondomaine.fr|$DOMAINE|g" "$RACINE/server/deploy/nginx.conf" \
  > /etc/nginx/sites-available/calendrier-api
ln -sf /etc/nginx/sites-available/calendrier-api /etc/nginx/sites-enabled/calendrier-api

# Avant le certificat, le bloc 443 ne peut pas être testé : on le neutralise
sed -i '/listen 443 ssl;/,$ s|^|#|' /etc/nginx/sites-available/calendrier-api
nginx -t && systemctl reload nginx

if ! command -v certbot >/dev/null; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
fi

# Restaure le bloc 443 puis laisse certbot le compléter
sed -i 's|^#||' /etc/nginx/sites-available/calendrier-api
certbot --nginx -d "$DOMAINE" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
  || rouge "  certbot a échoué — vérifie que $DOMAINE pointe bien vers ce serveur (enregistrement A)"

nginx -t && systemctl reload nginx

titre "Pare-feu"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
yes | ufw enable >/dev/null 2>&1 || true
vert "  ports 22, 80 et 443 ouverts"

titre "Sauvegarde automatique"
install -m 755 "$RACINE/server/scripts/backup.sh" /usr/local/bin/calendrier-backup
cat > /etc/cron.d/calendrier-backup <<'EOF'
# Sauvegarde de la base du calendrier, tous les jours à 3h15
15 3 * * * root /usr/local/bin/calendrier-backup >> /var/log/calendrier-backup.log 2>&1
EOF
vert "  sauvegarde quotidienne programmée (3h15) dans /var/backups/calendrier"

echo
vert "═══════════════════════════════════════════════"
vert " Installation terminée."
echo
echo " API      : https://$DOMAINE/api/health"
echo " Origine  : ${ORIGINE%/}"
echo " Base     : $RACINE/server/data/calendrier.db"
echo
echo " Vérifie :   curl https://$DOMAINE/api/health"
echo " Journaux :  journalctl -u calendrier-api -f"
echo
echo " Dans le site, ouvre « Compte & sauvegarde » et saisis :"
echo "     https://$DOMAINE"
echo
echo " ⚠  Une fois TON compte créé, repasse ALLOW_REGISTRATION=false"
echo "    dans $RACINE/server/.env puis : systemctl restart calendrier-api"
vert "═══════════════════════════════════════════════"
