#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Sauvegarde de la base SQLite du calendrier.
#
# Utilise « sqlite3 .backup », seule méthode sûre à chaud :
# copier le fichier .db pendant une écriture donnerait une
# base corrompue (le mode WAL garde des données à part).
#
#   ./backup.sh              sauvegarde ponctuelle
#   Lancé chaque nuit par /etc/cron.d/calendrier-backup
# ═══════════════════════════════════════════════════════════
set -euo pipefail

BASE="${DB_PATH:-/opt/calendrier/server/data/calendrier.db}"
DEST="${BACKUP_DIR:-/var/backups/calendrier}"
RETENTION_JOURS="${RETENTION_DAYS:-30}"
HORODATAGE="$(date +%Y-%m-%d_%H%M%S)"
FICHIER="$DEST/calendrier-$HORODATAGE.db"

mkdir -p "$DEST"

if [[ ! -f "$BASE" ]]; then
  echo "[$(date -Is)] ERREUR : base introuvable ($BASE)" >&2
  exit 1
fi

# Copie cohérente, même pendant une écriture
if command -v sqlite3 >/dev/null; then
  sqlite3 "$BASE" ".backup '$FICHIER'"
else
  echo "[$(date -Is)] sqlite3 absent — installe-le : apt install sqlite3" >&2
  exit 1
fi

# Vérifie que la copie est saine avant de la garder
if [[ "$(sqlite3 "$FICHIER" 'PRAGMA integrity_check;')" != "ok" ]]; then
  echo "[$(date -Is)] ERREUR : sauvegarde corrompue, abandon" >&2
  rm -f "$FICHIER"
  exit 1
fi

gzip -9 "$FICHIER"
TAILLE="$(du -h "$FICHIER.gz" | cut -f1)"

# Rotation
SUPPRIMES="$(find "$DEST" -name 'calendrier-*.db.gz' -mtime "+$RETENTION_JOURS" -print -delete | wc -l)"

echo "[$(date -Is)] OK  $FICHIER.gz ($TAILLE)  ·  $SUPPRIMES ancienne(s) sauvegarde(s) supprimée(s)"

# ─── Copie hors-site (optionnel mais recommandé) ───
# Une sauvegarde sur le même serveur ne protège pas d'une panne disque.
# Décommente et adapte l'une de ces lignes :
#
# rsync -az "$FICHIER.gz" utilisateur@autre-machine:/sauvegardes/calendrier/
# rclone copy "$FICHIER.gz" remote:calendrier/
# scp "$FICHIER.gz" utilisateur@nas.local:/volume1/backups/
