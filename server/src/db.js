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
    pseudo      TEXT NOT NULL UNIQUE COLLATE NOCASE,
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

  /* ── Catégories ──
     Rattachées au calendrier, pas à la personne : tous ceux qui
     partagent un calendrier voient et modifient les mêmes. */
  CREATE TABLE IF NOT EXISTS categories (
    calendrier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id            TEXT NOT NULL,
    label         TEXT NOT NULL DEFAULT '',
    color         TEXT NOT NULL DEFAULT '#94A3B8',
    ordre         INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    deleted       INTEGER NOT NULL DEFAULT 0,
    seq           INTEGER NOT NULL,
    PRIMARY KEY (calendrier_id, id)
  );
  CREATE INDEX IF NOT EXISTS categories_seq ON categories(calendrier_id, seq);

  /* ── Partage ──
     Un « calendrier » est identifié par l'id de son propriétaire :
     events.user_id est en réalité l'identifiant du calendrier.
     Cette table dit qui d'autre y a accès. Le propriétaire n'y
     figure pas : son droit est implicite. */
  CREATE TABLE IF NOT EXISTS partages (
    calendrier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role          TEXT NOT NULL DEFAULT 'ecriture',
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (calendrier_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS partages_user ON partages(user_id);

  CREATE TABLE IF NOT EXISTS invitations (
    code          TEXT PRIMARY KEY,
    calendrier_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role          TEXT NOT NULL DEFAULT 'ecriture',
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    used_by       TEXT,
    used_at       INTEGER
  );
  CREATE INDEX IF NOT EXISTS invitations_cal ON invitations(calendrier_id);

  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0);
`);

/* Purge des invitations périmées ou déjà consommées, une fois par jour */
const purgeInvits = db.prepare(
  'DELETE FROM invitations WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)'
);
function purgerInvitations() {
  const n = purgeInvits.run(Date.now(), Date.now() - 7 * 24 * 3600 * 1000).changes;
  if (n) console.log(`[db] ${n} invitation(s) périmée(s) purgée(s)`);
}
purgerInvitations();
setInterval(purgerInvitations, 24 * 3600 * 1000).unref();

/* ─────────── Migration : « email » devient « pseudo » ───────────
   Les bases créées avant ce changement ont une colonne email.
   On reconstruit la table, en conservant comptes et données.
   Les clés étrangères sont désactivées le temps de l'opération :
   sans cela, le DROP TABLE effacerait sessions et événements. */
{
  const colonnes = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (colonnes.includes('email') && !colonnes.includes('pseudo')) {
    console.log('[db] migration en cours : email → pseudo');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE users_v2 (
          id          TEXT PRIMARY KEY,
          pseudo      TEXT NOT NULL UNIQUE COLLATE NOCASE,
          pass        TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        );
        INSERT INTO users_v2 (id, pseudo, pass, created_at)
          SELECT id,
                 CASE WHEN instr(email, '@') > 1
                      THEN substr(email, 1, instr(email, '@') - 1)
                      ELSE email END,
                 pass, created_at
          FROM users;
        DROP TABLE users;
        ALTER TABLE users_v2 RENAME TO users;
      `);
      db.exec('COMMIT');
      const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
      console.log(`[db] migration terminée — ${n} compte(s) conservé(s)`);
    } catch (e) {
      db.exec('ROLLBACK');
      console.error('[db] migration impossible :', e.message);
      throw e;
    }
    db.exec('PRAGMA foreign_keys = ON');
  }
}

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
