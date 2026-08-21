/* ═══════════════════════════════════════════════════════════
   auth.js — comptes, mots de passe (scrypt) et sessions
   Aucune dépendance externe : tout vient de node:crypto.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const { db } = require('./db');

const DUREE_SESSION = 90 * 24 * 3600 * 1000;   // 90 jours
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/* ─────────── Mots de passe ─────────── */

function hacher(motDePasse) {
  const sel = crypto.randomBytes(16);
  const cle = crypto.scryptSync(motDePasse, sel, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sel.toString('base64')}$${cle.toString('base64')}`;
}

function verifier(motDePasse, stocke) {
  try {
    const [algo, N, r, p, sel, cle] = String(stocke).split('$');
    if (algo !== 'scrypt') return false;
    const attendu = Buffer.from(cle, 'base64');
    const calcule = crypto.scryptSync(motDePasse, Buffer.from(sel, 'base64'), attendu.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem
    });
    return crypto.timingSafeEqual(attendu, calcule);
  } catch {
    return false;
  }
}

/* ─────────── Sessions (jetons opaques, révocables) ─────────── */

function hashJeton(jeton) {
  return crypto.createHash('sha256').update(jeton).digest('hex');
}

const insSession   = db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)');
const selSession   = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');
const touchSession = db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?');
const delSession   = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const selUser      = db.prepare('SELECT id, pseudo, created_at FROM users WHERE id = ?');

function creerSession(userId) {
  const jeton = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  insSession.run(hashJeton(jeton), userId, now, now, now + DUREE_SESSION);
  return jeton;
}

function detruireSession(jeton) {
  if (jeton) delSession.run(hashJeton(jeton));
}

/** Renvoie l'utilisateur associé au jeton, ou null */
function utilisateurDuJeton(jeton) {
  if (!jeton) return null;
  const s = selSession.get(hashJeton(jeton));
  if (!s) return null;
  if (s.expires_at < Date.now()) { delSession.run(s.token_hash); return null; }
  // last_seen n'est rafraîchi qu'une fois par heure : évite une écriture par requête
  if (Date.now() - s.last_seen > 3600 * 1000) touchSession.run(Date.now(), s.token_hash);
  return selUser.get(s.user_id) || null;
}

/** Lit le jeton « Authorization: Bearer … » */
function jetonDeLaRequete(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1] : null;
}

/* ─────────── Limitation de débit (en mémoire) ─────────── */

const compteurs = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of compteurs) if (v.reset < now) compteurs.delete(k);
}, 60_000).unref();

/**
 * Renvoie null si la requête passe, sinon le nombre de secondes à attendre.
 * Protège surtout /api/auth du bourrinage de mots de passe.
 */
function limiter(cle, max, fenetreMs) {
  const now = Date.now();
  let e = compteurs.get(cle);
  if (!e || e.reset < now) { e = { n: 0, reset: now + fenetreMs }; compteurs.set(cle, e); }
  e.n++;
  return e.n > max ? Math.ceil((e.reset - now) / 1000) : null;
}

module.exports = {
  hacher, verifier,
  creerSession, detruireSession, utilisateurDuJeton, jetonDeLaRequete,
  limiter, DUREE_SESSION
};
