/* ═══════════════════════════════════════════════════════════
   e2e.js — tests de bout en bout de l'API
   Lance un vrai serveur sur une base temporaire, puis
   l'interroge en HTTP comme le ferait le navigateur.

     cd server && npm test
   ═══════════════════════════════════════════════════════════ */
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

/* ── Environnement de test, à définir AVANT de charger le serveur ── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'calendrier-test-'));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.ALLOWED_ORIGINS = 'https://exemple.github.io';
process.env.ALLOW_REGISTRATION = 'true';
process.env.MAX_EVENTS_PER_USER = '50';

const { serveur } = require('../src/server');

let ok = 0, ko = 0;
function eq(nom, obtenu, attendu) {
  const A = JSON.stringify(obtenu), B = JSON.stringify(attendu);
  if (A === B) { ok++; console.log('  ok   ' + nom); }
  else { ko++; console.log(`  KO   ${nom}\n        attendu ${B}\n        obtenu  ${A}`); }
}
function vrai(nom, cond) { eq(nom, !!cond, true); }

let BASE = '';
async function appel(chemin, { methode = 'GET', body, jeton, origine } = {}) {
  const entetes = { Accept: 'application/json' };
  if (body !== undefined) entetes['Content-Type'] = 'application/json';
  if (jeton) entetes.Authorization = 'Bearer ' + jeton;
  if (origine) entetes.Origin = origine;

  const res = await fetch(BASE + chemin, {
    method: methode, headers: entetes,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const texte = await res.text();
  let data = null;
  try { data = texte ? JSON.parse(texte) : null; } catch { /* non JSON */ }
  return { statut: res.status, data, entetes: res.headers };
}

const ev = (id, extra = {}) => ({
  id, title: 'Événement ' + id, notes: '', location: '',
  date: '2026-08-20', endDate: null, allDay: false,
  startTime: '09:00', endTime: '10:00', cat: 'perso',
  important: false, done: false, repeat: 'none', skip: [],
  createdAt: 1000, updatedAt: 1000, deleted: 0, ...extra
});

(async () => {
  await new Promise(r => serveur.listen(0, '127.0.0.1', r));
  BASE = 'http://127.0.0.1:' + serveur.address().port;
  console.log('Serveur de test : ' + BASE + '\n');

  /* ─────────── Santé ─────────── */
  console.log('── Santé ──');
  {
    const r = await appel('/api/health');
    eq('health 200', r.statut, 200);
    eq('health ok', r.data.ok, true);
    vrai('health version', typeof r.data.version === 'string');
  }
  {
    const r = await appel('/api/inconnu');
    eq('route inconnue 404', r.statut, 404);
    const m = await appel('/api/health', { methode: 'POST', body: {} });
    eq('mauvaise méthode 405', m.statut, 405);
  }

  /* ─────────── CORS ─────────── */
  console.log('\n── CORS ──');
  {
    // /api/me applique la politique stricte
    const bon = await appel('/api/me', { origine: 'https://exemple.github.io' });
    eq('origine autorisée', bon.entetes.get('access-control-allow-origin'), 'https://exemple.github.io');

    const mauvais = await appel('/api/me', { origine: 'https://pirate.example' });
    eq('origine refusée : aucun en-tête', mauvais.entetes.get('access-control-allow-origin'), null);

    // /api/health est volontairement public, pour permettre le diagnostic
    const sante = await appel('/api/health', { origine: 'https://pirate.example' });
    eq('health lisible par tous', sante.entetes.get('access-control-allow-origin'), '*');
    eq('health rapporte l’origine vue', sante.data.origineVue, 'https://pirate.example');
    eq('health signale le refus', sante.data.origineAutorisee, false);
    eq('health compte les origines', sante.data.originesConfigurees, 1);

    const santeOk = await appel('/api/health', { origine: 'https://exemple.github.io' });
    eq('health confirme une origine valide', santeOk.data.origineAutorisee, true);

    const santeSansOrigine = await appel('/api/health');
    eq('health sans origine', santeSansOrigine.data.origineAutorisee, null);

    const pre = await fetch(BASE + '/api/sync', {
      method: 'OPTIONS',
      headers: { Origin: 'https://pirate.example', 'Access-Control-Request-Method': 'POST' }
    });
    eq('préflight pirate refusé', pre.status, 403);

    const preOk = await fetch(BASE + '/api/sync', {
      method: 'OPTIONS',
      headers: { Origin: 'https://exemple.github.io', 'Access-Control-Request-Method': 'POST' }
    });
    eq('préflight légitime', preOk.status, 204);
  }

  /* ─────────── Inscription ─────────── */
  console.log('\n── Inscription ──');
  let jetonA = '', userA = null;
  {
    const r = await appel('/api/auth/register', {
      methode: 'POST', body: { pseudo: 'Cyrillou', password: 'motdepasse123' }
    });
    eq('inscription 200', r.statut, 200);
    vrai('jeton renvoyé', typeof r.data.token === 'string' && r.data.token.length > 30);
    eq('pseudo conservé tel quel', r.data.user.pseudo, 'Cyrillou');
    vrai('aucun e-mail renvoyé', r.data.user.email === undefined);
    jetonA = r.data.token; userA = r.data.user;
  }
  {
    const dup = await appel('/api/auth/register', {
      methode: 'POST', body: { pseudo: 'Cyrillou', password: 'motdepasse123' }
    });
    eq('doublon 409', dup.statut, 409);

    // La colonne est en COLLATE NOCASE : la casse ne crée pas un second compte
    const casse = await appel('/api/auth/register', {
      methode: 'POST', body: { pseudo: 'CYRILLOU', password: 'motdepasse123' }
    });
    eq('doublon insensible à la casse 409', casse.statut, 409);

    const court = await appel('/api/auth/register', {
      methode: 'POST', body: { pseudo: 'zoe', password: 'court' }
    });
    eq('mot de passe court 400', court.statut, 400);

    for (const [libelle, p] of [
      ['pseudo trop court', 'ab'],
      ['pseudo trop long', 'a'.repeat(21)],
      ['pseudo avec espace', 'jean dupont'],
      ['pseudo avec @', 'jean@dupont'],
      ['pseudo commençant par un point', '.jean']
    ]) {
      const r = await appel('/api/auth/register', {
        methode: 'POST', body: { pseudo: p, password: 'motdepasse123' }
      });
      eq(libelle + ' rejeté', r.statut, 400);
    }
  }

  /* ─────────── Connexion ─────────── */
  console.log('\n── Connexion ──');
  {
    const faux = await appel('/api/auth/login', {
      methode: 'POST', body: { pseudo: 'Cyrillou', password: 'mauvais-mot-de-passe' }
    });
    eq('mauvais mot de passe 401', faux.statut, 401);
    eq('message neutre', faux.data.error, 'Pseudo ou mot de passe incorrect.');

    const inconnu = await appel('/api/auth/login', {
      methode: 'POST', body: { pseudo: 'personne', password: 'motdepasse123' }
    });
    eq('compte inconnu : même message', inconnu.data.error, 'Pseudo ou mot de passe incorrect.');

    const bon = await appel('/api/auth/login', {
      methode: 'POST', body: { pseudo: 'Cyrillou', password: 'motdepasse123' }
    });
    eq('connexion 200', bon.statut, 200);
    vrai('nouveau jeton', bon.data.token !== jetonA);

    const autreCasse = await appel('/api/auth/login', {
      methode: 'POST', body: { pseudo: 'cyrillou', password: 'motdepasse123' }
    });
    eq('connexion insensible à la casse', autreCasse.statut, 200);
  }

  /* ─────────── Session ─────────── */
  console.log('\n── Session ──');
  {
    eq('me sans jeton 401', (await appel('/api/me')).statut, 401);
    eq('me jeton bidon 401', (await appel('/api/me', { jeton: 'nimportequoi' })).statut, 401);
    const r = await appel('/api/me', { jeton: jetonA });
    eq('me 200', r.statut, 200);
    eq('me identité', r.data.user.pseudo, 'Cyrillou');
    vrai('mot de passe jamais renvoyé', r.data.user.pass === undefined);
  }

  /* ─────────── Synchronisation ─────────── */
  console.log('\n── Synchronisation ──');
  let curseurA = 0;
  {
    const r = await appel('/api/sync', {
      methode: 'POST', jeton: jetonA,
      body: { cursor: 0, events: [ev('aaaaaaaa-1'), ev('aaaaaaaa-2'), ev('aaaaaaaa-3')] }
    });
    eq('envoi 200', r.statut, 200);
    eq('3 écrits', r.data.ecrits, 3);
    eq('total 3', r.data.total, 3);
    eq('renvoi des 3', r.data.events.length, 3);
    vrai('curseur avancé', r.data.cursor > 0);
    curseurA = r.data.cursor;
  }
  {
    const rien = await appel('/api/sync', {
      methode: 'POST', jeton: jetonA, body: { cursor: curseurA, events: [] }
    });
    eq('rien de neuf', rien.data.events.length, 0);
    eq('curseur stable', rien.data.cursor, curseurA);
  }
  {
    // Deuxième appareil : curseur 0, il doit tout récupérer
    const autre = await appel('/api/sync', {
      methode: 'POST', jeton: jetonA, body: { cursor: 0, events: [] }
    });
    eq('2e appareil récupère tout', autre.data.events.length, 3);
    eq('aller-retour fidèle', autre.data.events[0].startTime, '09:00');
    eq('allDay booléen', autre.data.events[0].allDay, false);
    eq('skip tableau', autre.data.events[0].skip, []);
  }

  /* ─────────── Conflits ─────────── */
  console.log('\n── Conflits ──');
  {
    const vieux = await appel('/api/sync', {
      methode: 'POST', jeton: jetonA,
      body: { cursor: curseurA, events: [ev('aaaaaaaa-1', { title: 'Version périmée', updatedAt: 500 })] }
    });
    const t1 = vieux.data.events.find(e => e.id === 'aaaaaaaa-1');
    eq('modification plus ancienne ignorée', t1 ? t1.title : 'Événement aaaaaaaa-1', 'Événement aaaaaaaa-1');

    const neuf = await appel('/api/sync', {
      methode: 'POST', jeton: jetonA,
      body: { cursor: 0, events: [ev('aaaaaaaa-1', { title: 'Version récente', updatedAt: 9999 })] }
    });
    eq('modification plus récente acceptée',
       neuf.data.events.find(e => e.id === 'aaaaaaaa-1').title, 'Version récente');
  }

  /* ─────────── Suppression ─────────── */
  console.log('\n── Suppression ──');
  {
    const r = await appel('/api/sync', {
      methode: 'POST', jeton: jetonA,
      body: { cursor: 0, events: [ev('aaaaaaaa-3', { deleted: 1, updatedAt: 9999 })] }
    });
    eq('total après suppression', r.data.total, 2);
    const t = r.data.events.find(e => e.id === 'aaaaaaaa-3');
    eq('pierre tombale propagée', t.deleted, 1);
  }

  /* ─────────── Validation des entrées ─────────── */
  console.log('\n── Validation ──');
  {
    const r = await appel('/api/sync', {
      methode: 'POST', jeton: jetonA,
      body: { cursor: 0, events: [
        { id: 'court', date: '2026-01-01' },                    // id trop court
        { id: 'bbbbbbbb-1', date: 'pas-une-date' },             // date invalide
        null,                                                    // rien
        ev('bbbbbbbb-2', { cat: 'pirate', repeat: 'chaque-lune', startTime: '99:99' })
      ] }
    });
    eq('3 rejets', r.data.rejetes, 3);
    eq('1 écrit', r.data.ecrits, 1);
    const e = r.data.events.find(x => x.id === 'bbbbbbbb-2');
    eq('catégorie inconnue -> perso', e.cat, 'perso');
    eq('répétition inconnue -> none', e.repeat, 'none');
    eq('heure invalide -> null', e.startTime, null);
  }
  {
    const long = 'x'.repeat(5000);
    const r = await appel('/api/sync', {
      methode: 'POST', jeton: jetonA,
      body: { cursor: 0, events: [ev('bbbbbbbb-3', { title: long, updatedAt: 3000 })] }
    });
    eq('titre tronqué à 300', r.data.events.find(x => x.id === 'bbbbbbbb-3').title.length, 300);
  }
  {
    const r = await fetch(BASE + '/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jetonA },
      body: '{ ceci nest pas du json'
    });
    eq('JSON invalide 400', r.status, 400);
  }

  /* ─────────── Cloisonnement entre comptes ─────────── */
  console.log('\n── Cloisonnement ──');
  {
    const b = await appel('/api/auth/register', {
      methode: 'POST', body: { pseudo: 'Autre', password: 'motdepasse123' }
    });
    const r = await appel('/api/sync', { methode: 'POST', jeton: b.data.token, body: { cursor: 0, events: [] } });
    eq('compte B ne voit rien de A', r.data.events.length, 0);
    eq('total B', r.data.total, 0);

    // B tente d'écraser un événement de A : il crée le sien, isolé
    await appel('/api/sync', {
      methode: 'POST', jeton: b.data.token,
      body: { cursor: 0, events: [ev('aaaaaaaa-1', { title: 'Détourné', updatedAt: 999999 })] }
    });
    const verifA = await appel('/api/sync', { methode: 'POST', jeton: jetonA, body: { cursor: 0, events: [] } });
    eq("les données de A sont intactes",
       verifA.data.events.find(e => e.id === 'aaaaaaaa-1').title, 'Version récente');
  }

  /* ─────────── Quota ─────────── */
  console.log('\n── Quota ──');
  {
    const paquet = [];
    for (let i = 0; i < 60; i++) paquet.push(ev('cccccccc-' + String(i).padStart(3, '0')));
    const r = await appel('/api/sync', { methode: 'POST', jeton: jetonA, body: { cursor: 0, events: paquet } });
    eq('quota dépassé 413', r.statut, 413);

    const apres = await appel('/api/me', { jeton: jetonA });
    eq('transaction annulée (rien écrit)', apres.data.evenements, 4);
  }

  /* ─────────── Export ─────────── */
  console.log('\n── Export ──');
  {
    const r = await appel('/api/export', { jeton: jetonA });
    eq('export 200', r.statut, 200);
    eq('export : supprimés exclus', r.data.events.length, 4);
    vrai('pièce jointe', /attachment/.test(r.entetes.get('content-disposition')));
    eq('export sans jeton 401', (await appel('/api/export')).statut, 401);
  }

  /* ─────────── Déconnexion ─────────── */
  console.log('\n── Déconnexion ──');
  {
    eq('logout 200', (await appel('/api/auth/logout', { methode: 'POST', jeton: jetonA })).statut, 200);
    eq('jeton révoqué', (await appel('/api/me', { jeton: jetonA })).statut, 401);
  }

  /* ─────────── Limitation de débit ─────────── */
  console.log('\n── Limitation de débit ──');
  {
    let bloque = false, statut = 0;
    for (let i = 0; i < 40; i++) {
      const r = await appel('/api/auth/login', {
        methode: 'POST', body: { pseudo: 'Cyrillou', password: 'faux' + i }
      });
      if (r.statut === 429) { bloque = true; statut = r.statut; break; }
    }
    vrai('bourrinage bloqué (429)', bloque && statut === 429);
  }

  /* ─────────── Fin ─────────── */
  serveur.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* verrou Windows */ }

  console.log('\n' + (ko ? `${ko} ÉCHEC(S) sur ${ok + ko}` : `Tous les tests passent (${ok})`));
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
