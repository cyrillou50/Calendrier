#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Restauration d'une sauvegarde du calendrier.
#
#   sudo bash restore.sh /var/backups/calendrier/calendrier-2026-08-20_031500.db.gz
#
# La base actuelle est mise de côté avant remplacement.
# ═══════════════════════════════════════════════════════════
set -euo pipefail

ARCHIVE="${1:-}"
BASE="${DB_PATH:-/opt/calendrier/server/data/calendrier.db}"
SERVICE="calendrier-api"

if [[ -z "$ARCHIVE" ]]; then
  echo "Usage : sudo bash restore.sh <fichier.db.gz>"
  echo
  echo "Sauvegardes disponibles :"
  ls -lh /var/backups/calendrier/*.db.gz 2>/dev/null || echo "  (aucune)"
  exit 1
fi
[[ -f "$ARCHIVE" ]] || { echo "Fichier introuvable : $ARCHIVE" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "▸ Décompression…"
gunzip -c "$ARCHIVE" > "$TMP/restore.db"

echo "▸ Vérification de l'intégrité…"
if [[ "$(sqlite3 "$TMP/restore.db" 'PRAGMA integrity_check;')" != "ok" ]]; then
  echo "ERREUR : cette sauvegarde est corrompue. Rien n'a été modifié." >&2
  exit 1
fi
N="$(sqlite3 "$TMP/restore.db" 'SELECT COUNT(*) FROM events WHERE deleted = 0;')"
U="$(sqlite3 "$TMP/restore.db" 'SELECT COUNT(*) FROM users;')"
echo "  → $U compte(s), $N événement(s)"

read -rp "Remplacer la base actuelle ? [oui/non] " REPONSE
[[ "$REPONSE" == "oui" ]] || { echo "Annulé."; exit 0; }

echo "▸ Arrêt du service…"
systemctl stop "$SERVICE"

if [[ -f "$BASE" ]]; then
  SECOURS="$BASE.avant-restauration-$(date +%Y%m%d_%H%M%S)"
  mv "$BASE" "$SECOURS"
  rm -f "$BASE-wal" "$BASE-shm"
  echo "  base précédente conservée : $SECOURS"
fi

install -o calendrier -g calendrier -m 640 "$TMP/restore.db" "$BASE"

echo "▸ Redémarrage…"
systemctl start "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" && echo "✓ Restauration terminée." \
  || { echo "Le service n'a pas redémarré :" >&2; journalctl -u "$SERVICE" -n 20 --no-pager; exit 1; }
