/* ═══════════════════════════════════════════════════════════
   server.js — API du calendrier
   Zéro dépendance : node:http + node:sqlite + node:crypto.
   Écoute en local (127.0.0.1) ; Nginx s'occupe du HTTPS.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

chargerEnv(path.join(__dirname, '..', '.env'));

const { db, prochaineSeq, seqCourante, transaction, FICHIER } = require('./db');
const A = require('./auth');

const VERSION = '1.0.0';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ORIGINES = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
const INSCRIPTIONS_OUVERTES = String(process.env.ALLOW_REGISTRATION ?? 'true') !== 'false';
const MAX_EVENEMENTS = Number(process.env.MAX_EVENTS_PER_USER || 20000);
const TAILLE_MAX = 8 * 1024 * 1024;   // 8 Mo par requête
const LOT_SYNC = 2000;                // événements renvoyés par appel

/* ═════════════════ Requêtes préparées ═════════════════ */
const insUser      = db.prepare('INSERT INTO users (id, pseudo, pass, created_at) VALUES (?, ?, ?, ?)');
const parPseudo    = db.prepare('SELECT * FROM users WHERE pseudo = ?');   // COLLATE NOCASE
const selEvent     = db.prepare('SELECT updated_at FROM events WHERE user_id = ? AND id = ?');
const compteEvents = db.prepare('SELECT COUNT(*) c FROM events WHERE user_id = ? AND deleted = 0');
const depuisSeq    = db.prepare(`SELECT * FROM events WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ${LOT_SYNC}`);
const tousEvents   = db.prepare('SELECT * FROM events WHERE user_id = ? AND deleted = 0 ORDER BY date');
const upsEvent     = db.prepare(`
  INSERT INTO events (user_id, id, title, notes, location, date, end_date, all_day,
                      start_time, end_time, cat, important, done, repeat, skip,
                      created_at, updated_at, deleted, seq)
  VALUES (:user_id, :id, :title, :notes, :location, :date, :end_date, :all_day,
          :start_time, :end_time, :cat, :important, :done, :repeat, :skip,
          :created_at, :updated_at, :deleted, :seq)
  ON CONFLICT(user_id, id) DO UPDATE SET
    title=:title, notes=:notes, location=:location, date=:date, end_date=:end_date,
    all_day=:all_day, start_time=:start_time, end_time=:end_time, cat=:cat,
    important=:important, done=:done, repeat=:repeat, skip=:skip,
    updated_at=:updated_at, deleted=:deleted, seq=:seq
`);

/* ═════════════════ Routes ═════════════════ */
const routes = [];
const on = (methode, chemin, gestionnaire, options = {}) =>
  routes.push({ methode, chemin, gestionnaire, ...options });

/* ── Santé ──
   Volontairement lisible depuis n'importe quelle origine (voir le bloc
   CORS plus bas) : c'est le seul moyen pour le navigateur de distinguer
   « l'API refuse mon site » de « ce n'est pas l'API qui a répondu ».
   Aucune donnée personnelle n'y transite. */
on('GET', '/api/health', (req) => {
  const vue = req.headers.origin ? req.headers.origin.replace(/\/+$/, '') : null;
  return {
    ok: true,
    version: VERSION,
    inscriptions: INSCRIPTIONS_OUVERTES,
    // Diagnostic : ce que le serveur voit, et ce qu'il accepte
    origineVue: vue,
    origineAutorisee: vue === null ? null : (ORIGINES.includes('*') || ORIGINES.includes(vue)),
    originesConfigurees: ORIGINES.length,
    heure: Date.now()
  };
});

/* ── Inscription ── */
on('POST', '/api/auth/register', (req) => {
  if (!INSCRIPTIONS_OUVERTES) {
    throw httpErr(403, 'Les inscriptions sont fermées sur ce serveur.');
  }
  const { pseudo, password } = req.body || {};

  const nom = String(pseudo || '').trim();
  if (!RE_PSEUDO.test(nom)) {
    throw httpErr(400, 'Pseudo invalide : 3 à 20 caractères, lettres, chiffres, tiret, point ou souligné.');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw httpErr(400, 'Le mot de passe doit faire au moins 8 caractères.');
  }
  if (password.length > 200) throw httpErr(400, 'Mot de passe trop long.');
  // La colonne est en COLLATE NOCASE : « Cyril » et « cyril » sont le même compte
  if (parPseudo.get(nom)) throw httpErr(409, 'Ce pseudo est déjà pris.');

  const id = crypto.randomUUID();
  insUser.run(id, nom, A.hacher(password), Date.now());

  console.log(`[auth] nouveau compte : ${nom}`);
  return { token: A.creerSession(id), user: { id, pseudo: nom } };
}, { limite: [10, 15 * 60_000] });

/* ── Connexion ── */
on('POST', '/api/auth/login', (req) => {
  const { pseudo, password } = req.body || {};
  const u = parPseudo.get(String(pseudo || '').trim());

  // Message identique dans les deux cas : ne révèle pas l'existence du compte
  if (!u || !A.verifier(String(password || ''), u.pass)) {
    throw httpErr(401, 'Pseudo ou mot de passe incorrect.');
  }
  return { token: A.creerSession(u.id), user: { id: u.id, pseudo: u.pseudo } };
}, { limite: [20, 15 * 60_000] });

on('POST', '/api/auth/logout', (req) => {
  A.detruireSession(req.jeton);
  return { ok: true };
}, { auth: true });

on('GET', '/api/me', (req) => ({
  user: req.user,
  evenements: compteEvents.get(req.user.id).c
}), { auth: true });

/* ── Synchronisation bidirectionnelle ── */
on('POST', '/api/sync', (req) => {
  const entrants = Array.isArray(req.body?.events) ? req.body.events : [];
  const curseur = Number(req.body?.cursor) || 0;

  if (entrants.length > 5000) {
    throw httpErr(400, 'Trop d’événements en une seule fois (5000 maximum).');
  }

  let ecrits = 0, rejetes = 0;

  transaction(() => {
    const dejaLa = compteEvents.get(req.user.id).c;
    let ajouts = 0;

    for (const brut of entrants) {
      const e = valider(brut, req.user.id);
      if (!e) { rejetes++; continue; }

      const actuel = selEvent.get(req.user.id, e.id);
      // Résolution des conflits : la version la plus récente l'emporte
      if (actuel && actuel.updated_at > e.updated_at) continue;
      if (!actuel && !e.deleted && dejaLa + ++ajouts > MAX_EVENEMENTS) {
        throw httpErr(413, 'Quota d’événements atteint pour ce compte.');
      }
      // Un numéro de séquence unique PAR événement : le curseur renvoyé
      // reste exact même si la réponse doit être tronquée.
      e.seq = prochaineSeq();
      upsEvent.run(e);
      ecrits++;
    }
  });

  const lignes = depuisSeq.all(req.user.id, curseur);
  const tronque = lignes.length === LOT_SYNC;

  return {
    // Si la réponse est tronquée, le curseur s'arrête à la dernière ligne
    // envoyée : le client redemandera la suite.
    cursor: tronque ? lignes[lignes.length - 1].seq : seqCourante(),
    events: lignes.map(versClient),
    more: tronque,
    total: compteEvents.get(req.user.id).c,
    ecrits, rejetes
  };
}, { auth: true });

/* ── Export complet ── */
on('GET', '/api/export', (req, res) => {
  res.setHeader('Content-Disposition',
    `attachment; filename="calendrier-${req.user.pseudo.replace(/[^\w.-]/g, '_')}.json"`);
  return {
    app: 'calendrier', version: 1,
    exportedAt: new Date().toISOString(),
    user: { pseudo: req.user.pseudo },
    events: tousEvents.all(req.user.id).map(versClient)
  };
}, { auth: true });

/* ═════════════════ Validation ═════════════════ */

const CATS = ['perso', 'travail', 'rappel', 'autre'];
const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_HEURE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Pseudo : 3 à 20 caractères, lettres/chiffres/. _ -
const RE_PSEUDO = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,18})[A-Za-z0-9]$/;

const txt = (v, max) => String(v ?? '').slice(0, max);

/** Nettoie un événement reçu du client. Renvoie null s'il est inexploitable.
    Le champ `seq` est attribué juste avant l'écriture. */
function valider(b, userId) {
  if (!b || typeof b !== 'object') return null;
  if (typeof b.id !== 'string' || b.id.length < 8 || b.id.length > 64) return null;
  if (typeof b.date !== 'string' || !RE_DATE.test(b.date)) return null;

  const allDay = b.allDay ? 1 : 0;
  const skip = Array.isArray(b.skip)
    ? b.skip.filter(s => typeof s === 'string' && RE_DATE.test(s)).slice(0, 500).join(',')
    : '';

  return {
    user_id: userId,
    id: b.id,
    title: txt(b.title, 300) || 'Sans titre',
    notes: txt(b.notes, 10000),
    location: txt(b.location, 300),
    date: b.date,
    end_date: RE_DATE.test(String(b.endDate)) ? b.endDate : null,
    all_day: allDay,
    start_time: !allDay && RE_HEURE.test(String(b.startTime)) ? b.startTime : null,
    end_time: !allDay && RE_HEURE.test(String(b.endTime)) ? b.endTime : null,
    cat: CATS.includes(b.cat) ? b.cat : 'perso',
    important: b.important ? 1 : 0,
    done: b.done ? 1 : 0,
    repeat: REPEATS.includes(b.repeat) ? b.repeat : 'none',
    skip,
    created_at: Number.isFinite(b.createdAt) ? Math.floor(b.createdAt) : Date.now(),
    updated_at: Number.isFinite(b.updatedAt) ? Math.floor(b.updatedAt) : Date.now(),
    deleted: b.deleted ? 1 : 0,
    seq: 0
  };
}

function versClient(r) {
  return {
    id: r.id, title: r.title, notes: r.notes, location: r.location,
    date: r.date, endDate: r.end_date, allDay: !!r.all_day,
    startTime: r.start_time, endTime: r.end_time,
    cat: r.cat, important: !!r.important, done: !!r.done,
    repeat: r.repeat, skip: r.skip ? r.skip.split(',') : [],
    createdAt: r.created_at, updatedAt: r.updated_at, deleted: r.deleted
  };
}

/* ═════════════════ Serveur HTTP ═════════════════ */

function httpErr(statut, message) {
  return Object.assign(new Error(message), { statut });
}

function ipDe(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'inconnu';
}

function repondre(res, statut, corps) {
  const json = JSON.stringify(corps);
  res.writeHead(statut, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(json);
}

function corps(req) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    let taille = 0;
    req.on('data', (c) => {
      taille += c.length;
      if (taille > TAILLE_MAX) {
        reject(httpErr(413, 'Données trop volumineuses.'));
        req.destroy();
        return;
      }
      morceaux.push(c);
    });
    req.on('end', () => {
      if (!morceaux.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(morceaux).toString('utf8')));
      } catch {
        reject(httpErr(400, 'JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

const serveur = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://interne');
  const chemin = url.pathname.replace(/\/+$/, '') || '/';

  /* ── CORS ── */
  const origine = req.headers.origin;

  // /api/health est un point de diagnostic public : toujours lisible.
  // Sans cela, un site mal configuré ne peut pas savoir POURQUOI il est
  // rejeté — le navigateur masque la réponse avant qu'on puisse la lire.
  if (chemin === '/api/health') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origine) {
    const nettoyee = origine.replace(/\/+$/, '');
    if (ORIGINES.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (ORIGINES.includes(nettoyee)) {
      res.setHeader('Access-Control-Allow-Origin', origine);
      res.setHeader('Vary', 'Origin');
    } else if (req.method === 'OPTIONS') {
      // Origine inconnue : on refuse le préflight
      res.writeHead(403).end();
      return;
    }
    // Sinon la réponse part sans en-tête CORS et le navigateur la bloque :
    // c'est exactement le comportement voulu.
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  /* ── Routage ── */
  const route = routes.find(r => r.chemin === chemin && r.methode === req.method);
  if (!route) {
    const cheminConnu = routes.some(r => r.chemin === chemin);
    return repondre(res, cheminConnu ? 405 : 404,
      { error: cheminConnu ? 'Méthode non autorisée.' : 'Route inconnue.' });
  }

  try {
    if (route.limite) {
      const attente = A.limiter(ipDe(req) + ':' + chemin, route.limite[0], route.limite[1]);
      if (attente !== null) {
        res.setHeader('Retry-After', String(attente));
        throw httpErr(429, 'Trop de tentatives. Réessaie dans un instant.');
      }
    }

    if (route.auth) {
      const jeton = A.jetonDeLaRequete(req);
      const user = A.utilisateurDuJeton(jeton);
      if (!user) throw httpErr(401, 'Session invalide ou expirée.');
      req.user = user;
      req.jeton = jeton;
    }

    if (req.method === 'POST') req.body = await corps(req);

    repondre(res, 200, await route.gestionnaire(req, res));
  } catch (e) {
    if (e.statut) return repondre(res, e.statut, { error: e.message });
    console.error('[erreur]', chemin, e);
    repondre(res, 500, { error: 'Erreur interne du serveur.' });
  }
});

serveur.headersTimeout = 20_000;
serveur.requestTimeout = 60_000;

if (require.main === module) {
  serveur.listen(PORT, HOST, () => {
    console.log('┌───────────────────────────────────────────────');
    console.log('│ API Calendrier ' + VERSION);
    console.log(`│ Écoute        : http://${HOST}:${PORT}`);
    console.log(`│ Base          : ${FICHIER}`);
    console.log(`│ Origines CORS : ${ORIGINES.length ? ORIGINES.join(', ') : '(aucune)'}`);
    console.log(`│ Inscriptions  : ${INSCRIPTIONS_OUVERTES ? 'ouvertes' : 'fermées'}`);
    console.log('└───────────────────────────────────────────────');
    if (!ORIGINES.length) {
      console.warn('⚠  ALLOWED_ORIGINS est vide : le navigateur bloquera les appels depuis GitHub Pages.');
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n[${sig}] arrêt en cours…`);
      serveur.close(() => { try { db.close(); } catch {} process.exit(0); });
      setTimeout(() => process.exit(0), 4000).unref();
    });
  }
}

/* ─────────── Mini chargeur .env ─────────── */
function chargerEnv(fichier) {
  if (!fs.existsSync(fichier)) return;
  for (const ligne of fs.readFileSync(fichier, 'utf8').split('\n')) {
    const l = ligne.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i === -1) continue;
    const cle = l.slice(0, i).trim();
    let val = l.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[cle] === undefined) process.env[cle] = val;
  }
}

module.exports = { serveur, PORT, HOST };
