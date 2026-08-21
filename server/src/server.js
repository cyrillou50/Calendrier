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

// Limites de débit, par IP et par quart d'heure. Configurables pour
// les tests automatisés, qui créent beaucoup de comptes d'affilée.
const LIMITE_INSCRIPTION = Number(process.env.RATE_LIMIT_REGISTER || 10);
const LIMITE_CONNEXION   = Number(process.env.RATE_LIMIT_LOGIN || 20);

// Longueur minimale du mot de passe. Volontairement basse : c'est la
// limitation de débit ci-dessus qui porte l'essentiel de la protection
// contre le bourrinage, pas la longueur.
const MDP_MIN = Number(process.env.PASSWORD_MIN_LENGTH || 4);

/* ═════════════════ Requêtes préparées ═════════════════ */
const insUser      = db.prepare('INSERT INTO users (id, pseudo, pass, created_at) VALUES (?, ?, ?, ?)');
const parPseudo    = db.prepare('SELECT * FROM users WHERE pseudo = ?');   // COLLATE NOCASE
const selEvent     = db.prepare('SELECT updated_at FROM events WHERE user_id = ? AND id = ?');
const compteEvents = db.prepare('SELECT COUNT(*) c FROM events WHERE user_id = ? AND deleted = 0');
const depuisSeq    = db.prepare(`SELECT * FROM events WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ${LOT_SYNC}`);
const tousEvents   = db.prepare('SELECT * FROM events WHERE user_id = ? AND deleted = 0 ORDER BY date');
const selCat       = db.prepare('SELECT updated_at FROM categories WHERE calendrier_id = ? AND id = ?');
const catsDepuis   = db.prepare('SELECT * FROM categories WHERE calendrier_id = ? AND seq > ? ORDER BY seq LIMIT 500');
const toutesCats   = db.prepare('SELECT * FROM categories WHERE calendrier_id = ? AND deleted = 0 ORDER BY ordre');
const upsCat       = db.prepare(`
  INSERT INTO categories (calendrier_id, id, label, color, ordre, created_at, updated_at, deleted, seq)
  VALUES (:calendrier_id, :id, :label, :color, :ordre, :created_at, :updated_at, :deleted, :seq)
  ON CONFLICT(calendrier_id, id) DO UPDATE SET
    label=:label, color=:color, ordre=:ordre,
    updated_at=:updated_at, deleted=:deleted, seq=:seq
`);
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
  if (typeof password !== 'string' || password.length < MDP_MIN) {
    throw httpErr(400, `Le mot de passe doit faire au moins ${MDP_MIN} caractères.`);
  }
  if (password.length > 200) throw httpErr(400, 'Mot de passe trop long.');
  // La colonne est en COLLATE NOCASE : « Cyril » et « cyril » sont le même compte
  if (parPseudo.get(nom)) throw httpErr(409, 'Ce pseudo est déjà pris.');

  const id = crypto.randomUUID();
  insUser.run(id, nom, A.hacher(password), Date.now());

  console.log(`[auth] nouveau compte : ${nom}`);
  return { token: A.creerSession(id), user: { id, pseudo: nom }, calendriers: calendriersDe(id) };
}, { limite: [LIMITE_INSCRIPTION, 15 * 60_000] });

/* ── Connexion ── */
on('POST', '/api/auth/login', (req) => {
  const { pseudo, password } = req.body || {};
  const u = parPseudo.get(String(pseudo || '').trim());

  // Message identique dans les deux cas : ne révèle pas l'existence du compte
  if (!u || !A.verifier(String(password || ''), u.pass)) {
    throw httpErr(401, 'Pseudo ou mot de passe incorrect.');
  }
  return { token: A.creerSession(u.id), user: { id: u.id, pseudo: u.pseudo }, calendriers: calendriersDe(u.id) };
}, { limite: [LIMITE_CONNEXION, 15 * 60_000] });

on('POST', '/api/auth/logout', (req) => {
  A.detruireSession(req.jeton);
  return { ok: true };
}, { auth: true });

on('GET', '/api/me', (req) => ({
  user: req.user,
  evenements: compteEvents.get(req.user.id).c,
  calendriers: calendriersDe(req.user.id)
}), { auth: true });

/* ═════════════════ PARTAGE ═════════════════ */

const selPartage    = db.prepare('SELECT role FROM partages WHERE calendrier_id = ? AND user_id = ?');
const insPartage    = db.prepare('INSERT INTO partages (calendrier_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(calendrier_id, user_id) DO UPDATE SET role = excluded.role');
const delPartage    = db.prepare('DELETE FROM partages WHERE calendrier_id = ? AND user_id = ?');
const membresDuCal  = db.prepare('SELECT p.user_id, p.role, p.created_at, u.pseudo FROM partages p JOIN users u ON u.id = p.user_id WHERE p.calendrier_id = ? ORDER BY u.pseudo');
const calsPartages  = db.prepare('SELECT p.calendrier_id, p.role, u.pseudo FROM partages p JOIN users u ON u.id = p.calendrier_id WHERE p.user_id = ? ORDER BY u.pseudo');
const insInvit      = db.prepare('INSERT INTO invitations (code, calendrier_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
const selInvit      = db.prepare('SELECT * FROM invitations WHERE code = ?');
const majInvit      = db.prepare('UPDATE invitations SET used_by = ?, used_at = ? WHERE code = ?');
const invitsActives = db.prepare('SELECT code, role, expires_at FROM invitations WHERE calendrier_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC');
const delInvit      = db.prepare('DELETE FROM invitations WHERE code = ? AND calendrier_id = ?');
const parId         = db.prepare('SELECT id, pseudo FROM users WHERE id = ?');

const DUREE_INVITATION = 7 * 24 * 3600 * 1000;   // 7 jours

/** Rôle d'un utilisateur sur un calendrier : 'proprietaire' | 'ecriture' | 'lecture' | null */
function roleSur(userId, calendrierId) {
  if (userId === calendrierId) return 'proprietaire';
  const p = selPartage.get(calendrierId, userId);
  return p ? p.role : null;
}

/** Tous les calendriers accessibles à un utilisateur, le sien en premier */
function calendriersDe(userId) {
  const moi = parId.get(userId);
  const liste = [{ id: userId, pseudo: moi ? moi.pseudo : '', role: 'proprietaire' }];
  for (const c of calsPartages.all(userId)) {
    liste.push({ id: c.calendrier_id, pseudo: c.pseudo, role: c.role });
  }
  return liste;
}

/* Alphabet sans caractères ambigus : ni 0/O, ni 1/I/L */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function codeInvitation() {
  const octets = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[octets[i] % ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

/* ── Créer une invitation ── */
on('POST', '/api/partage/inviter', (req) => {
  const role = req.body?.role === 'lecture' ? 'lecture' : 'ecriture';

  // On n'invite que sur SON propre calendrier : pas de partage en cascade
  const actives = invitsActives.all(req.user.id, Date.now());
  if (actives.length >= 10) {
    throw httpErr(429, 'Trop d’invitations en attente. Annule celles qui ne servent plus.');
  }

  let code = codeInvitation();
  for (let i = 0; i < 5 && selInvit.get(code); i++) code = codeInvitation();
  if (selInvit.get(code)) throw httpErr(500, 'Impossible de générer un code.');

  const expire = Date.now() + DUREE_INVITATION;
  insInvit.run(code, req.user.id, role, Date.now(), expire);
  console.log(`[partage] ${req.user.pseudo} a créé une invitation (${role})`);
  return { code, role, expire };
}, { auth: true, limite: [20, 3600_000] });

/* ── Rejoindre avec un code ── */
on('POST', '/api/partage/rejoindre', (req) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const inv = selInvit.get(code);

  // Message unique : un code invalide et un code expiré se ressemblent
  if (!inv || inv.used_at || inv.expires_at < Date.now()) {
    throw httpErr(404, 'Code invalide, déjà utilisé ou expiré.');
  }
  if (inv.calendrier_id === req.user.id) {
    throw httpErr(400, 'Ce calendrier est déjà le tien.');
  }
  if (selPartage.get(inv.calendrier_id, req.user.id)) {
    throw httpErr(409, 'Tu as déjà accès à ce calendrier.');
  }

  transaction(() => {
    insPartage.run(inv.calendrier_id, req.user.id, inv.role, Date.now());
    majInvit.run(req.user.id, Date.now(), code);
  });

  const proprio = parId.get(inv.calendrier_id);
  console.log(`[partage] ${req.user.pseudo} a rejoint le calendrier de ${proprio?.pseudo}`);
  return {
    calendrier: { id: inv.calendrier_id, pseudo: proprio ? proprio.pseudo : '?', role: inv.role },
    calendriers: calendriersDe(req.user.id)
  };
}, { auth: true, limite: [30, 3600_000] });

/* ═════════════════ PRÉSENCE ═════════════════
   Volontairement gardée en mémoire : une présence n'a aucun sens
   après un redémarrage, et cela évite une écriture disque par minute
   et par personne connectée. */

const FENETRE_PRESENCE = 120_000;          // au-delà, on considère la personne partie
const presences = new Map();               // "calendrierId|userId" -> horodatage

function marquerPresence(userId, calendrierId) {
  presences.set(calendrierId + '|' + userId, Date.now());
}

/** Date de dernière activité d'une personne sur un calendrier, ou null */
function vuLe(userId, calendrierId) {
  const t = presences.get(calendrierId + '|' + userId);
  return t && Date.now() - t < FENETRE_PRESENCE * 30 ? t : null;
}

function estEnLigne(userId, calendrierId) {
  const t = presences.get(calendrierId + '|' + userId);
  return !!t && Date.now() - t < FENETRE_PRESENCE;
}

/** Qui est actuellement sur ce calendrier (hors soi-même) */
function presentsSur(calendrierId, saufUserId) {
  const out = [];
  const limite = Date.now() - FENETRE_PRESENCE;
  for (const [cle, ts] of presences) {
    if (ts < limite) continue;
    const sep = cle.indexOf('|');
    if (cle.slice(0, sep) !== calendrierId) continue;
    const uid = cle.slice(sep + 1);
    if (uid === saufUserId) continue;
    const u = parId.get(uid);
    if (u) out.push({ id: uid, pseudo: u.pseudo, vuLe: ts });
  }
  return out;
}

// Purge des présences périmées, toutes les 5 minutes
setInterval(() => {
  const limite = Date.now() - FENETRE_PRESENCE * 30;
  for (const [cle, ts] of presences) if (ts < limite) presences.delete(cle);
}, 5 * 60_000).unref();

/* ── Battement de cœur ── */
on('POST', '/api/presence', (req) => {
  const calId = String(req.body?.calendrier || req.user.id);
  if (!roleSur(req.user.id, calId)) throw httpErr(403, 'Tu n’as pas accès à ce calendrier.');

  marquerPresence(req.user.id, calId);
  return { presents: presentsSur(calId, req.user.id) };
}, { auth: true });

/* ── État du partage ── */
on('GET', '/api/partage', (req) => ({
  membres: membresDuCal.all(req.user.id).map(m => ({
    id: m.user_id, pseudo: m.pseudo, role: m.role, depuis: m.created_at,
    enLigne: estEnLigne(m.user_id, req.user.id),
    vuLe: vuLe(m.user_id, req.user.id)
  })),
  invitations: invitsActives.all(req.user.id, Date.now()),
  calendriers: calendriersDe(req.user.id).map(c => (
    c.role === 'proprietaire' ? c : Object.assign({}, c, {
      // pour un calendrier partagé : le propriétaire y est-il en ce moment ?
      enLigne: estEnLigne(c.id, c.id),
      vuLe: vuLe(c.id, c.id)
    })
  )),
  presents: presentsSur(req.user.id, req.user.id)
}), { auth: true });

/* ── Retirer un accès ──
   Le propriétaire exclut un membre ; un invité peut se retirer lui-même. */
on('POST', '/api/partage/retirer', (req) => {
  const calendrierId = String(req.body?.calendrier || req.user.id);
  const userId = String(req.body?.utilisateur || req.user.id);

  const jeSuisProprio = calendrierId === req.user.id;
  const jeMeRetire = userId === req.user.id;
  if (!jeSuisProprio && !jeMeRetire) {
    throw httpErr(403, 'Tu ne peux retirer que tes propres accès.');
  }
  if (jeSuisProprio && jeMeRetire) {
    throw httpErr(400, 'Tu ne peux pas te retirer de ton propre calendrier.');
  }

  const n = delPartage.run(calendrierId, userId).changes;
  if (!n) throw httpErr(404, 'Aucun accès à retirer.');
  return { ok: true, calendriers: calendriersDe(req.user.id) };
}, { auth: true });

/* ── Annuler une invitation non utilisée ── */
on('POST', '/api/partage/annuler', (req) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const n = delInvit.run(code, req.user.id).changes;
  if (!n) throw httpErr(404, 'Invitation introuvable.');
  return { ok: true };
}, { auth: true });

/* ── Synchronisation bidirectionnelle ── */
on('POST', '/api/sync', (req) => {
  const entrants = Array.isArray(req.body?.events) ? req.body.events : [];
  const curseur = Number(req.body?.cursor) || 0;

  // Calendrier ciblé : le sien par défaut
  const calId = String(req.body?.calendrier || req.user.id);
  const role = roleSur(req.user.id, calId);
  if (!role) throw httpErr(403, 'Tu n’as pas accès à ce calendrier.');

  marquerPresence(req.user.id, calId);   // synchroniser vaut signe de vie

  if (entrants.length && role === 'lecture') {
    throw httpErr(403, 'Tu es en lecture seule sur ce calendrier.');
  }

  if (entrants.length > 5000) {
    throw httpErr(400, 'Trop d’événements en une seule fois (5000 maximum).');
  }

  const catsEntrantes = Array.isArray(req.body?.categories) ? req.body.categories : [];
  if (catsEntrantes.length && role === 'lecture') {
    throw httpErr(403, 'Tu es en lecture seule sur ce calendrier.');
  }
  if (catsEntrantes.length > 200) {
    throw httpErr(400, 'Trop de catégories en une seule fois.');
  }

  let ecrits = 0, rejetes = 0, catsEcrites = 0;

  transaction(() => {
    for (const brut of catsEntrantes) {
      const c = validerCat(brut, calId);
      if (!c) { rejetes++; continue; }
      const actuel = selCat.get(calId, c.id);
      if (actuel && actuel.updated_at > c.updated_at) continue;
      c.seq = prochaineSeq();
      upsCat.run(c);
      catsEcrites++;
    }

    const dejaLa = compteEvents.get(calId).c;
    let ajouts = 0;

    for (const brut of entrants) {
      const e = valider(brut, calId);
      if (!e) { rejetes++; continue; }

      const actuel = selEvent.get(calId, e.id);
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

  const lignes = depuisSeq.all(calId, curseur);
  const tronque = lignes.length === LOT_SYNC;

  const cursor = tronque ? lignes[lignes.length - 1].seq : seqCourante();

  // Les catégories sont peu nombreuses : jamais tronquées. Celles dont le
  // seq dépasse un curseur ramené en arrière seront simplement renvoyées
  // au tour suivant — la fusion est idempotente.
  const cats = catsDepuis.all(calId, curseur).map(catVersClient);

  return {
    // Si la réponse est tronquée, le curseur s'arrête à la dernière ligne
    // envoyée : le client redemandera la suite.
    cursor,
    events: lignes.map(versClient),
    categories: cats,
    more: tronque,
    total: compteEvents.get(calId).c,
    calendrier: calId,
    role,
    ecrits, rejetes, catsEcrites
  };
}, { auth: true });

/* ── Export complet ── */
on('GET', '/api/export', (req, res) => {
  const calId = String(req.query.get('calendrier') || req.user.id);
  if (!roleSur(req.user.id, calId)) throw httpErr(403, 'Tu n’as pas accès à ce calendrier.');

  const proprio = parId.get(calId);
  const nom = (proprio ? proprio.pseudo : 'export').replace(/[^\w.-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="calendrier-${nom}.json"`);
  return {
    app: 'calendrier', version: 2,
    exportedAt: new Date().toISOString(),
    calendrier: { id: calId, pseudo: proprio ? proprio.pseudo : null },
    cats: toutesCats.all(calId).map(catVersClient),
    events: tousEvents.all(calId).map(versClient)
  };
}, { auth: true });

/* ═════════════════ Validation ═════════════════ */

// Les catégories sont désormais définies par l'utilisateur : on ne valide
// plus qu'un identifiant sûr, pas une liste fermée.
const RE_CAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RE_COULEUR = /^#[0-9a-fA-F]{6}$/;
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
    cat: RE_CAT_ID.test(String(b.cat)) ? b.cat : 'perso',
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

/** Nettoie une catégorie reçue du client. Renvoie null si inexploitable. */
function validerCat(b, calendrierId) {
  if (!b || typeof b !== 'object') return null;
  if (typeof b.id !== 'string' || !RE_CAT_ID.test(b.id)) return null;

  return {
    calendrier_id: calendrierId,
    id: b.id,
    label: txt(b.label, 40) || 'Sans nom',
    color: RE_COULEUR.test(String(b.color)) ? b.color : '#94A3B8',
    ordre: Number.isFinite(b.ordre) ? Math.max(0, Math.min(999, Math.floor(b.ordre))) : 0,
    created_at: Number.isFinite(b.createdAt) ? Math.floor(b.createdAt) : Date.now(),
    updated_at: Number.isFinite(b.updatedAt) ? Math.floor(b.updatedAt) : Date.now(),
    deleted: b.deleted ? 1 : 0,
    seq: 0
  };
}

function catVersClient(r) {
  return {
    id: r.id, label: r.label, color: r.color, ordre: r.ordre,
    createdAt: r.created_at, updatedAt: r.updated_at, deleted: r.deleted
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
  req.query = url.searchParams;

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
