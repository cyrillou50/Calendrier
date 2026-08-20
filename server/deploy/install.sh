#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Installation de l'API Calendrier sur un VPS Debian/Ubuntu
#
#   sudo bash install.sh api.mondomaine.fr https://ton-pseudo.github.io
#
# Aucune dépendance npm : l'API n'utilise que les modules
# intégrés à Node.js. Le script est idempotent, tu peux le
# relancer sans risque.
# ═══════════════════════════════════════════════════════════
set -euo pipefail

DOMAINE="${1:-}"
ORIGINE="${2:-}"
RACINE="/opt/calendrier"
UTILISATEUR="calendrier"

rouge() { printf '\033[31m%s\033[0m\n' "$*"; }
vert()  { printf '\033[32m%s\033[0m\n' "$*"; }
titre() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { rouge "Ce script doit être lancé avec sudo."; exit 1; }

if [[ -z "$DOMAINE" || -z "$ORIGINE" ]]; then
  rouge "Usage : sudo bash install.sh <domaine-api> <origine-github-pages>"
  echo   "Exemple : sudo bash install.sh api.mondomaine.fr https://cyril.github.io"
  exit 1
fi

titre "1/8 · Paquets système"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg nginx ufw sqlite3 >/dev/null
vert "  nginx, sqlite3 et outils installés"

titre "2/8 · Node.js 24"
# node:sqlite est intégré et stable à partir de Node 24 — aucun module à compiler
BESOIN_NODE=1
if command -v node >/dev/null; then
  MAJEURE="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$MAJEURE" -ge 24 ]] && BESOIN_NODE=0
fi
if [[ "$BESOIN_NODE" -eq 1 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -e "require('node:sqlite')" 2>/dev/null \
  || { rouge "  node:sqlite indisponible avec $(node -v) — Node 24+ est requis."; exit 1; }
vert "  $(node -v) · module node:sqlite disponible"

titre "3/8 · Utilisateur et dossiers"
id -u "$UTILISATEUR" >/dev/null 2>&1 \
  || useradd --system --home "$RACINE" --shell /usr/sbin/nologin "$UTILISATEUR"
mkdir -p "$RACINE/server/data" /var/backups/calendrier

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$SRC" != "$RACINE/server" ]]; then
  cp -r "$SRC/src" "$SRC/package.json" "$RACINE/server/"
  for d in scripts deploy test; do
    [[ -d "$SRC/$d" ]] && cp -r "$SRC/$d" "$RACINE/server/"
  done
fi
vert "  sources déployées dans $RACINE/server"

titre "4/8 · Fichier .env"
if [[ -f "$RACINE/server/.env" ]]; then
  vert "  .env existant conservé"
else
  cat > "$RACINE/server/.env" <<EOF
PORT=8787
HOST=127.0.0.1
ALLOWED_ORIGINS=${ORIGINE%/}
ALLOW_REGISTRATION=true
DATA_DIR=$RACINE/server/data
MAX_EVENTS_PER_USER=20000
EOF
  vert "  .env créé — origine autorisée : ${ORIGINE%/}"
fi
chown -R "$UTILISATEUR:$UTILISATEUR" "$RACINE" /var/backups/calendrier
chmod 600 "$RACINE/server/.env"

titre "5/8 · Vérification de l'API"
if sudo -u "$UTILISATEUR" env DATA_DIR=/tmp DB_PATH=/tmp/verif-calendrier.db \
     node "$RACINE/server/test/e2e.js" >/tmp/calendrier-test.log 2>&1; then
  vert "  $(grep -c '  ok ' /tmp/calendrier-test.log) tests passent"
else
  rouge "  les tests ont échoué :"; tail -20 /tmp/calendrier-test.log; exit 1
fi
rm -f /tmp/verif-calendrier.db*

titre "6/8 · Service systemd"
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

titre "7/8 · Nginx + certificat HTTPS"
sed "s|api.mondomaine.fr|$DOMAINE|g" "$RACINE/server/deploy/nginx.conf" \
  > /etc/nginx/sites-available/calendrier-api
ln -sf /etc/nginx/sites-available/calendrier-api /etc/nginx/sites-enabled/calendrier-api

# Tant que le certificat n'existe pas, le bloc 443 empêcherait nginx de démarrer :
# on le neutralise, certbot le rétablira.
awk '/listen 443 ssl;/{ssl=1} ssl{print "#" $0; next} {print}' \
  /etc/nginx/sites-available/calendrier-api > /tmp/nginx-calendrier.tmp
mv /tmp/nginx-calendrier.tmp /etc/nginx/sites-available/calendrier-api
nginx -t && systemctl reload nginx

command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null

if certbot --nginx -d "$DOMAINE" --non-interactive --agree-tos \
     --register-unsafely-without-email --redirect; then
  vert "  certificat obtenu pour $DOMAINE"
else
  rouge "  certbot a échoué."
  rouge "  Vérifie que $DOMAINE pointe bien vers ce serveur (enregistrement DNS de type A)"
  rouge "  puis relance :  sudo certbot --nginx -d $DOMAINE"
fi
nginx -t && systemctl reload nginx

titre "8/8 · Pare-feu et sauvegardes"
ufw allow OpenSSH        >/dev/null 2>&1 || true
ufw allow 'Nginx Full'   >/dev/null 2>&1 || true
yes | ufw enable         >/dev/null 2>&1 || true
vert "  ports 22, 80 et 443 ouverts"

install -m 755 "$RACINE/server/scripts/backup.sh" /usr/local/bin/calendrier-backup
cat > /etc/cron.d/calendrier-backup <<'EOF'
# Sauvegarde de la base du calendrier, tous les jours à 3h15
15 3 * * * root /usr/local/bin/calendrier-backup >> /var/log/calendrier-backup.log 2>&1
EOF
/usr/local/bin/calendrier-backup >/dev/null 2>&1 && vert "  première sauvegarde effectuée" || true
vert "  sauvegarde quotidienne programmée (3h15) dans /var/backups/calendrier"

echo
vert "═══════════════════════════════════════════════════"
vert " Installation terminée."
echo
echo "  API      : https://$DOMAINE/api/health"
echo "  Origine  : ${ORIGINE%/}"
echo "  Base     : $RACINE/server/data/calendrier.db"
echo
echo "  Vérifie  :  curl https://$DOMAINE/api/health"
echo "  Journaux :  journalctl -u calendrier-api -f"
echo
echo "  Sur le site, ouvre « Compte & sauvegarde » et saisis :"
echo "      https://$DOMAINE"
echo
echo "  ⚠  Une fois TON compte créé, ferme les inscriptions :"
echo "      sudo sed -i 's/ALLOW_REGISTRATION=true/ALLOW_REGISTRATION=false/' $RACINE/server/.env"
echo "      sudo systemctl restart calendrier-api"
vert "═══════════════════════════════════════════════════"
