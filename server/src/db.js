/* ═══════════════════════════════════════════════════════════
   db.js — base SQLite (un seul fichier, sauvegarde triviale)
   Utilise node:sqlite, intégré à Node.js 22.5+ : aucune
   dépendance externe, aucune compilation sur le serveur.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const fs = require('fs');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error(
    `\n✖ Le module « node:sqlite » est indisponible avec Node ${process.versions.node}.\n` +
    '  Cette API nécessite Node.js 24 ou plus récent (aucune autre dépendance).\n' +
    '  Installation :  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - \\\n' +
    '                  && sudo apt-get install -y nodejs\n'
  );
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const FICHIER = process.env.DB_PATH || path.join(DATA_DIR, 'calendrier.db');
const db = new DatabaseSync(FICHIER);

// WAL : lectures pendant les écritures, et sauvegarde à chaud possible
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL DEFAULT '',
    pass        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS events (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    location    TEXT NOT NULL DEFAULT '',
    date        TEXT NOT NULL,
    end_date    TEXT,
    all_day     INTEGER NOT NULL DEFAULT 0,
    start_time  TEXT,
    end_time    TEXT,
    cat         TEXT NOT NULL DEFAULT 'perso',
    important   INTEGER NOT NULL DEFAULT 0,
    done        INTEGER NOT NULL DEFAULT 0,
    repeat      TEXT NOT NULL DEFAULT 'none',
    skip        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS events_seq ON events(user_id, seq);

  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0);
`);

/* Compteur monotone global : sert de curseur de synchronisation.
   Plus fiable qu'un horodatage — pas de collision, pas de dérive d'horloge. */
const _bump = db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'seq'");
const _lire = db.prepare("SELECT v FROM meta WHERE k = 'seq'");

function prochaineSeq() {
  _bump.run();
  return _lire.get().v;
}
function seqCourante() {
  return _lire.get().v;
}

/* node:sqlite n'a pas d'aide aux transactions : on l'écrit à la main. */
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* déjà annulée */ }
    throw e;
  }
}

/* Purge des sessions expirées : au démarrage, puis une fois par jour */
const purgeSessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
function purger() {
  const n = purgeSessions.run(Date.now()).changes;
  if (n) console.log(`[db] ${n} session(s) expirée(s) purgée(s)`);
}
purger();
setInterval(purger, 24 * 3600 * 1000).unref();

module.exports = { db, FICHIER, DATA_DIR, prochaineSeq, seqCourante, transaction };
