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
PORT_IMPOSE="${3:-}"            # port explicite, optionnel
PORT="${PORT_IMPOSE:-8787}"     # sinon 8787, ou le premier port libre au-dessus
RACINE="/opt/calendrier"
UTILISATEUR="calendrier"

rouge() { printf '\033[31m%s\033[0m\n' "$*"; }
vert()  { printf '\033[32m%s\033[0m\n' "$*"; }
titre() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { rouge "Ce script doit être lancé avec sudo."; exit 1; }

if [[ -z "$DOMAINE" || -z "$ORIGINE" ]]; then
  rouge "Usage : sudo bash install.sh <domaine-api> <origine-github-pages> [port]"
  echo   "Exemple : sudo bash install.sh api.mondomaine.fr https://cyril.github.io"
  echo   "Le port est facultatif : 8787 par défaut, ou le premier libre s'il est pris."
  exit 1
fi

titre "1/8 · Paquets système"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg nginx ufw sqlite3 iproute2 procps >/dev/null
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

titre "4/8 · Port d'écoute et fichier .env"

# Une installation précédente peut avoir laissé un service en boucle
# de redémarrage, ou un processus orphelin qui retient le port.
systemctl stop calendrier-api        2>/dev/null || true
systemctl reset-failed calendrier-api 2>/dev/null || true
if pgrep -f "node .*$RACINE.*src/server.js" >/dev/null 2>&1; then
  pkill -f "node .*$RACINE.*src/server.js" 2>/dev/null || true
  sleep 1
  vert "  processus orphelin de l'API arrêté"
fi

occupe() { ss -tlnH "sport = :$1" 2>/dev/null | grep -q . ; }
qui()    { ss -tlnpH "sport = :$1" 2>/dev/null | grep -oP 'users:\(\("\K[^"]+' | head -1; }

if occupe "$PORT"; then
  VOLEUR="$(qui "$PORT")"
  if [[ -n "$PORT_IMPOSE" ]]; then
    rouge "  Le port $PORT est déjà utilisé par « ${VOLEUR:-processus inconnu} »."
    rouge "  Choisis-en un autre, ou libère celui-ci."
    exit 1
  fi
  vert "  port $PORT déjà pris par « ${VOLEUR:-processus inconnu} » — recherche d'un port libre"
  TROUVE=""
  for p in $(seq 8788 8850); do
    occupe "$p" || { TROUVE="$p"; break; }
  done
  [[ -n "$TROUVE" ]] || { rouge "  Aucun port libre entre 8788 et 8850."; exit 1; }
  PORT="$TROUVE"
fi
vert "  l'API écoutera sur 127.0.0.1:$PORT"

if [[ ! -f "$RACINE/server/.env" ]]; then
  cat > "$RACINE/server/.env" <<EOF
PORT=$PORT
HOST=127.0.0.1
ALLOWED_ORIGINS=${ORIGINE%/}
ALLOW_REGISTRATION=true
DATA_DIR=$RACINE/server/data
MAX_EVENTS_PER_USER=20000
EOF
  vert "  .env créé"
else
  # On conserve les réglages personnalisés, mais le port et l'origine
  # doivent rester cohérents avec ce que le script installe.
  regler() {
    grep -q "^$1=" "$RACINE/server/.env" \
      && sed -i "s|^$1=.*|$1=$2|" "$RACINE/server/.env" \
      || echo "$1=$2" >> "$RACINE/server/.env"
  }
  regler PORT "$PORT"
  regler HOST 127.0.0.1
  regler ALLOWED_ORIGINS "${ORIGINE%/}"
  regler DATA_DIR "$RACINE/server/data"
  vert "  .env existant mis à jour"
fi
vert "  origine autorisée : ${ORIGINE%/}"
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
systemctl enable calendrier-api >/dev/null 2>&1
systemctl restart calendrier-api
sleep 2

# On vérifie que l'API répond vraiment, pas seulement que systemd est content
if systemctl is-active --quiet calendrier-api \
   && curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  vert "  service actif et répond sur 127.0.0.1:$PORT"
else
  rouge "  le service n'a pas démarré correctement :"
  journalctl -u calendrier-api -n 25 --no-pager
  exit 1
fi

titre "7/8 · Nginx + certificat HTTPS"
CONF=/etc/nginx/sites-available/calendrier-api

if [[ -f "$CONF" ]] && grep -q 'ssl_certificate' "$CONF"; then
  # certbot a déjà configuré le TLS ici : on ne réécrit pas sa configuration,
  # on se contente de remettre le bon port de l'API.
  sed -i -E "s|proxy_pass http://127\.0\.0\.1:[0-9]+;|proxy_pass http://127.0.0.1:$PORT;|g" "$CONF"
  vert "  configuration HTTPS existante conservée (port réaligné sur $PORT)"
else
  # Modèle HTTP uniquement : c'est certbot qui ajoutera le bloc 443,
  # les certificats et la redirection.
  sed -e "s|api.mondomaine.fr|$DOMAINE|g" -e "s|127.0.0.1:8787|127.0.0.1:$PORT|g" \
    "$RACINE/server/deploy/nginx.conf" > "$CONF"
  vert "  configuration HTTP écrite (certbot ajoutera le HTTPS)"
fi

ln -sf "$CONF" /etc/nginx/sites-enabled/calendrier-api

if ! nginx -t 2>/tmp/nginx-test.log; then
  rouge "  configuration nginx invalide :"; cat /tmp/nginx-test.log
  rouge "  les autres sites de ce serveur ne sont pas affectés tant que nginx n'est pas rechargé."
  rm -f /etc/nginx/sites-enabled/calendrier-api
  exit 1
fi
systemctl reload nginx

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
# On n'active JAMAIS ufw nous-mêmes : sur un serveur qui héberge déjà
# d'autres services, l'activer couperait tout ce qui n'est pas
# explicitement autorisé ici. On se contente d'ouvrir ce dont on a besoin
# si le pare-feu est déjà en service.
if ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow OpenSSH      >/dev/null 2>&1 || true
  ufw allow 'Nginx Full' >/dev/null 2>&1 || true
  vert "  ufw actif : ports 22, 80 et 443 autorisés"
else
  vert "  ufw inactif — laissé tel quel (tes autres services ne sont pas touchés)"
  vert "  vérifie que les ports 80 et 443 sont ouverts chez ton hébergeur"
fi

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
  echo "  Port     : 127.0.0.1:$PORT"
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
