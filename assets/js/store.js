/* ═══════════════════════════════════════════════════════════
   store.js — modèle de données, dates et persistance locale
   Tout est stocké en localStorage, par utilisateur.
   Les dates sont des chaînes "YYYY-MM-DD" en heure LOCALE
   (jamais d'UTC : un rendez-vous du 3 mars reste le 3 mars).
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ─────────── Utilitaires de date ─────────── */
  var MOIS = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  var MOIS_C = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
  var JOURS = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
  var JOURS_C = ['dim.','lun.','mar.','mer.','jeu.','ven.','sam.'];

  var D = {
    MOIS: MOIS, MOIS_C: MOIS_C, JOURS: JOURS, JOURS_C: JOURS_C,

    /** Date -> "YYYY-MM-DD" (local) */
    ymd: function (d) {
      var m = d.getMonth() + 1, j = d.getDate();
      return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (j < 10 ? '0' : '') + j;
    },
    /** "YYYY-MM-DD" -> Date locale à minuit */
    parse: function (s) {
      var p = String(s).split('-');
      return new Date(+p[0], +p[1] - 1, +p[2]);
    },
    today: function () { return D.ymd(new Date()); },

    addDays: function (s, n) {
      var d = D.parse(s); d.setDate(d.getDate() + n); return D.ymd(d);
    },
    addMonths: function (s, n) {
      var d = D.parse(s), jour = d.getDate();
      d.setDate(1); d.setMonth(d.getMonth() + n);
      // conserve la fin de mois (31 janv. + 1 mois => 28/29 févr.)
      d.setDate(Math.min(jour, D.daysInMonth(d.getFullYear(), d.getMonth())));
      return D.ymd(d);
    },
    daysInMonth: function (y, m) { return new Date(y, m + 1, 0).getDate(); },

    /** Lundi de la semaine contenant s */
    startOfWeek: function (s) {
      var d = D.parse(s), dow = (d.getDay() + 6) % 7; // lundi = 0
      d.setDate(d.getDate() - dow); return D.ymd(d);
    },
    startOfMonth: function (s) { return s.slice(0, 8) + '01'; },

    /** Différence en jours (b - a) */
    diff: function (a, b) {
      return Math.round((D.parse(b) - D.parse(a)) / 86400000);
    },
    between: function (s, from, to) { return s >= from && s <= to; },

    /** Numéro de semaine ISO 8601 */
    week: function (s) {
      var d = D.parse(s);
      d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
      var jan4 = new Date(d.getFullYear(), 0, 4);
      return 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    },

    /* ── Formats d'affichage ── */
    longDate: function (s) {
      var d = D.parse(s);
      return JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()] + ' ' + d.getFullYear();
    },
    shortDate: function (s) {
      var d = D.parse(s);
      return d.getDate() + ' ' + MOIS_C[d.getMonth()];
    },
    monthYear: function (s) {
      var d = D.parse(s);
      return MOIS[d.getMonth()] + ' ' + d.getFullYear();
    },
    /** "aujourd'hui", "demain", "lun. 4 mars" */
    relative: function (s) {
      var n = D.diff(D.today(), s);
      if (n === 0) return "aujourd'hui";
      if (n === 1) return 'demain';
      if (n === -1) return 'hier';
      if (n > 1 && n < 7) return JOURS[D.parse(s).getDay()];
      return JOURS_C[D.parse(s).getDay()] + ' ' + D.shortDate(s);
    },
    /** "09:30" -> minutes depuis minuit */
    mins: function (t) {
      if (!t) return 0;
      var p = t.split(':'); return (+p[0]) * 60 + (+p[1] || 0);
    },
    hhmm: function (m) {
      var h = Math.floor(m / 60), mi = m % 60;
      return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
    }
  };

  /* ─────────── Catégories ───────────
     Modifiables par l'utilisateur et synchronisées comme les événements :
     une catégorie appartient au calendrier, donc tous ceux qui le partagent
     voient les mêmes. CATS est mutée sur place — jamais remplacée — pour que
     les références gardées ailleurs restent valides. */

  var COULEURS = [
    '#8B7CF6', '#22D3EE', '#34D399', '#FBBF24',
    '#FB7185', '#F97316', '#A3E635', '#38BDF8',
    '#E879F9', '#94A3B8'
  ];

  function catsDefaut() {
    return [
      { id: 'perso',   label: 'Personnel', color: '#8B7CF6', ordre: 0 },
      { id: 'travail', label: 'Travail',   color: '#22D3EE', ordre: 1 },
      { id: 'rappel',  label: 'Rappel',    color: '#FBBF24', ordre: 2 },
      { id: 'autre',   label: 'Autre',     color: '#94A3B8', ordre: 3 }
    ].map(function (c) {
      c.createdAt = 0; c.updatedAt = 0; c.deleted = 0;
      return c;
    });
  }

  var CATS = [];        // catégories vivantes, triées
  var CATS_TOUTES = {}; // id -> catégorie, y compris supprimées (pierres tombales)

  /** Reconstruit CATS à partir de CATS_TOUTES */
  function reconstruireCats() {
    var vivantes = [];
    for (var id in CATS_TOUTES) {
      if (!CATS_TOUTES[id].deleted) vivantes.push(CATS_TOUTES[id]);
    }
    vivantes.sort(function (a, b) {
      return (a.ordre - b.ordre) || a.label.localeCompare(b.label, 'fr');
    });
    CATS.length = 0;
    for (var i = 0; i < vivantes.length; i++) CATS.push(vivantes[i]);
  }

  /** Catégorie par id. Une catégorie supprimée reste affichable, en grisé. */
  function cat(id) {
    var c = CATS_TOUTES[id];
    if (c && !c.deleted) return c;
    if (c) return { id: c.id, label: c.label + ' (supprimée)', color: '#94A3B8', ordre: 999 };
    return CATS[0] || { id: 'perso', label: 'Sans catégorie', color: '#94A3B8', ordre: 0 };
  }

  /* ─────────── Identifiants ─────────── */
  function uid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    var s = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return s.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /* ═════════════════ Store ═════════════════ */
  var PREFIX = 'calendrier:v1:';
  var Store = {
    CATS: CATS,
    cat: cat,
    uid: uid,

    key: 'local',
    events: {},   // id -> événement (y compris supprimés = pierres tombales)
    lastSync: 0,  // horloge CLIENT : borne des modifications déjà envoyées
    cursor: 0,    // horloge SERVEUR : borne des modifications déjà reçues

    /* Bascule sur l'espace de stockage d'un utilisateur donné */
    open: function (key) {
      Store.key = key || 'local';
      Store._load();
      return Store;
    },

    _lsKey: function () { return PREFIX + Store.key; },

    _load: function () {
      Store.events = {};
      Store.lastSync = 0;
      Store.cursor = 0;
      CATS_TOUTES = {};

      var data = null;
      try {
        var raw = localStorage.getItem(Store._lsKey());
        if (raw) data = JSON.parse(raw);
      } catch (e) {
        console.warn('Lecture du stockage impossible :', e);
      }

      if (data) {
        Store.events = data.events || {};
        Store.lastSync = data.lastSync || 0;
        Store.cursor = data.cursor || 0;
        var liste = data.cats || [];
        for (var i = 0; i < liste.length; i++) {
          var c = normaliseCat(liste[i]);
          if (c) CATS_TOUTES[c.id] = c;
        }
      }

      // Premier usage de ce calendrier : on installe les catégories de base
      var vide = true;
      for (var k in CATS_TOUTES) { vide = false; break; }
      if (vide) {
        var def = catsDefaut();
        for (var j = 0; j < def.length; j++) CATS_TOUTES[def[j].id] = def[j];
      }
      reconstruireCats();
    },

    save: function () {
      try {
        var cats = [];
        for (var id in CATS_TOUTES) cats.push(CATS_TOUTES[id]);
        localStorage.setItem(Store._lsKey(), JSON.stringify({
          v: 2, events: Store.events, cats: cats,
          lastSync: Store.lastSync, cursor: Store.cursor
        }));
        return true;
      } catch (e) {
        console.error('Écriture impossible :', e);
        return false;
      }
    },

    /* ── Catégories ── */
    COULEURS: COULEURS,

    /** Crée ou modifie une catégorie. Renvoie la catégorie normalisée. */
    upsertCat: function (c) {
      var now = Date.now();
      var prev = c.id ? CATS_TOUTES[c.id] : null;
      var e = {
        id: c.id || uid(),
        label: (c.label || '').trim().slice(0, 40) || 'Sans nom',
        color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : COULEURS[0],
        ordre: Number.isFinite(c.ordre) ? c.ordre : (prev ? prev.ordre : CATS.length),
        createdAt: (prev && prev.createdAt) || now,
        updatedAt: now,
        deleted: 0
      };
      CATS_TOUTES[e.id] = e;
      reconstruireCats();
      Store.save();
      return e;
    },

    /** Supprime une catégorie et bascule ses événements vers `versId` */
    removeCat: function (id, versId) {
      var c = CATS_TOUTES[id];
      if (!c || c.deleted) return 0;
      if (CATS.length <= 1) return -1;          // on garde toujours une catégorie

      var repli = versId && CATS_TOUTES[versId] && !CATS_TOUTES[versId].deleted
        ? versId
        : (CATS.find(function (x) { return x.id !== id; }) || {}).id;

      var deplaces = 0, now = Date.now();
      for (var eid in Store.events) {
        var ev = Store.events[eid];
        if (ev.cat === id && !ev.deleted) {
          ev.cat = repli;
          ev.updatedAt = now;
          deplaces++;
        }
      }
      c.deleted = 1;
      c.updatedAt = now;
      reconstruireCats();
      Store.save();
      return deplaces;
    },

    /** Nombre d'événements vivants utilisant cette catégorie */
    compteCat: function (id) {
      var n = 0;
      for (var eid in Store.events) {
        if (!Store.events[eid].deleted && Store.events[eid].cat === id) n++;
      }
      return n;
    },

    catsChangesSince: function (since) {
      var out = [];
      for (var id in CATS_TOUTES) {
        if (CATS_TOUTES[id].updatedAt > (since || 0)) out.push(CATS_TOUTES[id]);
      }
      return out;
    },

    /** Fusionne les catégories du serveur — la plus récente gagne */
    applyRemoteCats: function (distantes) {
      var n = 0;
      for (var i = 0; i < distantes.length; i++) {
        var r = normaliseCat(distantes[i]);
        if (!r) continue;
        var local = CATS_TOUTES[r.id];
        if (!local || r.updatedAt > local.updatedAt) { CATS_TOUTES[r.id] = r; n++; }
      }
      if (n) { reconstruireCats(); Store.save(); }
      return n;
    },

    /* ── Lecture ── */
    /** Tous les événements vivants (hors supprimés) */
    all: function () {
      var out = [];
      for (var id in Store.events) {
        if (!Store.events[id].deleted) out.push(Store.events[id]);
      }
      return out;
    },
    get: function (id) {
      var e = Store.events[id];
      return e && !e.deleted ? e : null;
    },
    count: function () { return Store.all().length; },

    /* ── Écriture ── */
    /** Crée ou met à jour. Renvoie l'événement normalisé. */
    upsert: function (ev) {
      var now = Date.now();
      var prev = ev.id ? Store.events[ev.id] : null;
      var e = {
        id:        ev.id || uid(),
        title:     (ev.title || '').trim() || 'Sans titre',
        notes:     ev.notes || '',
        location:  ev.location || '',
        date:      ev.date,
        endDate:   ev.endDate || null,
        allDay:    !!ev.allDay,
        startTime: ev.allDay ? null : (ev.startTime || '09:00'),
        endTime:   ev.allDay ? null : (ev.endTime || null),
        cat:       ev.cat || 'perso',
        important: !!ev.important,
        done:      !!ev.done,
        repeat:    ev.repeat || 'none',
        skip:      ev.skip || (prev && prev.skip) || [],
        createdAt: (prev && prev.createdAt) || now,
        updatedAt: now,
        deleted:   0
      };
      // Cohérence : fin >= début
      if (e.endDate && e.endDate < e.date) e.endDate = e.date;
      if (e.endDate === e.date) e.endDate = null;
      if (!e.allDay && e.endTime && D.mins(e.endTime) <= D.mins(e.startTime)) {
        e.endTime = D.hhmm(Math.min(24 * 60, D.mins(e.startTime) + 60));
      }
      Store.events[e.id] = e;
      Store.save();
      return e;
    },

    /** Suppression douce (conservée comme pierre tombale pour la synchro) */
    remove: function (id) {
      var e = Store.events[id];
      if (!e) return false;
      e.deleted = 1;
      e.updatedAt = Date.now();
      Store.save();
      return true;
    },

    /** Masque une seule occurrence d'un événement récurrent */
    skipOccurrence: function (id, dateYMD) {
      var e = Store.events[id];
      if (!e) return false;
      if (e.skip.indexOf(dateYMD) === -1) e.skip.push(dateYMD);
      e.updatedAt = Date.now();
      Store.save();
      return true;
    },

    /** Bascule "terminé" — sur la série pour les récurrents */
    toggleDone: function (id) {
      var e = Store.events[id];
      if (!e) return null;
      e.done = !e.done;
      e.updatedAt = Date.now();
      Store.save();
      return e;
    },

    /* ═════ Occurrences ═════
       Développe les récurrences et les événements sur plusieurs jours
       en « occurrences » : { ev, date, spanStart, spanEnd, isStart } */
    occurrencesInRange: function (from, to, filters) {
      var out = [];
      var list = Store.all();

      for (var i = 0; i < list.length; i++) {
        var ev = list[i];
        if (!passeFiltres(ev, filters)) continue;

        var span = ev.endDate ? Math.max(0, D.diff(ev.date, ev.endDate)) : 0;
        var starts = departsDansPlage(ev, from, to, span);

        for (var s = 0; s < starts.length; s++) {
          var start = starts[s];
          if (ev.skip && ev.skip.indexOf(start) !== -1) continue;
          var end = span ? D.addDays(start, span) : start;
          // chaque jour couvert par l'occurrence
          for (var k = 0; k <= span; k++) {
            var jour = k ? D.addDays(start, k) : start;
            if (jour < from || jour > to) continue;
            out.push({
              ev: ev, date: jour, key: ev.id + '@' + start,
              occStart: start, occEnd: end,
              isStart: jour === start, isEnd: jour === end,
              multi: span > 0
            });
          }
        }
      }
      return out.sort(triOccurrences);
    },

    /** Occurrences d'un jour donné */
    onDay: function (ymd, filters) {
      return Store.occurrencesInRange(ymd, ymd, filters);
    },

    /** Les n prochaines occurrences à partir d'aujourd'hui */
    upcoming: function (n, filters) {
      var from = D.today();
      var occ = Store.occurrencesInRange(from, D.addDays(from, 120), filters);
      var vus = {}, out = [];
      for (var i = 0; i < occ.length && out.length < n; i++) {
        if (vus[occ[i].key]) continue;
        if (occ[i].ev.done) continue;
        vus[occ[i].key] = 1;
        out.push(occ[i]);
      }
      return out;
    },

    /** Recherche plein texte */
    search: function (q) {
      q = (q || '').trim().toLowerCase();
      if (q.length < 2) return [];
      var list = Store.all(), out = [];
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        var hay = (e.title + ' ' + e.notes + ' ' + e.location + ' ' + cat(e.cat).label).toLowerCase();
        var pos = hay.indexOf(q);
        if (pos !== -1) out.push({ ev: e, score: (e.title.toLowerCase().indexOf(q) === 0 ? 0 : 1) + pos / 1000 });
      }
      out.sort(function (a, b) { return a.score - b.score; });
      return out.slice(0, 12).map(function (r) { return r.ev; });
    },

    /** Compte les événements par catégorie (sur tout l'historique) */
    countByCat: function () {
      var m = {}, list = Store.all();
      for (var i = 0; i < list.length; i++) m[list[i].cat] = (m[list[i].cat] || 0) + 1;
      return m;
    },

    /* ═════ Synchronisation ═════ */
    /** Modifications locales postérieures à `since` (ms epoch) */
    changesSince: function (since) {
      var out = [];
      for (var id in Store.events) {
        if (Store.events[id].updatedAt > (since || 0)) out.push(Store.events[id]);
      }
      return out;
    },

    /** Fusionne les événements du serveur — le plus récent gagne */
    applyRemote: function (remote) {
      var n = 0;
      for (var i = 0; i < remote.length; i++) {
        var r = remote[i];
        var local = Store.events[r.id];
        if (!local || r.updatedAt > local.updatedAt) {
          Store.events[r.id] = normalise(r);
          n++;
        }
      }
      if (n) Store.save();
      return n;
    },

    /* ═════ Import / export ═════ */
    exportData: function () {
      return {
        app: 'calendrier', version: 2,
        exportedAt: new Date().toISOString(),
        cats: CATS.slice(),
        events: Store.all()
      };
    },

    /** Fusionne un export ; renvoie le nombre d'événements ajoutés/mis à jour */
    importData: function (data) {
      var list = (data && data.events) || [];
      if (!Array.isArray(list)) throw new Error('Format de fichier invalide');

      // Les catégories d'abord, sinon les événements importés pointeraient
      // vers des catégories inconnues.
      if (Array.isArray(data.cats)) {
        for (var c = 0; c < data.cats.length; c++) {
          var cc = normaliseCat(data.cats[c]);
          if (!cc) continue;
          var cur = CATS_TOUTES[cc.id];
          if (!cur || cc.updatedAt >= cur.updatedAt) CATS_TOUTES[cc.id] = cc;
        }
        reconstruireCats();
      }

      var n = 0;
      for (var i = 0; i < list.length; i++) {
        var e = normalise(list[i]);
        if (!e.id || !e.date) continue;
        var cur = Store.events[e.id];
        if (!cur || e.updatedAt >= cur.updatedAt) { Store.events[e.id] = e; n++; }
      }
      Store.save();
      return n;
    },

    /** Purge complète de l'espace courant */
    clear: function () {
      Store.events = {}; Store.lastSync = 0; Store.cursor = 0;
      CATS_TOUTES = {};
      var def = catsDefaut();
      for (var i = 0; i < def.length; i++) CATS_TOUTES[def[i].id] = def[i];
      reconstruireCats();
      try { localStorage.removeItem(Store._lsKey()); } catch (e) {}
    },

    /** Purge TOUS les calendriers mis en cache (déconnexion) */
    clearAll: function () {
      Store.events = {}; Store.lastSync = 0; Store.cursor = 0;
      try {
        var aSupprimer = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(PREFIX) === 0) aSupprimer.push(k);
        }
        for (var j = 0; j < aSupprimer.length; j++) localStorage.removeItem(aSupprimer[j]);
      } catch (e) {}
    },

    /** Taille approximative occupée (Ko) */
    sizeKb: function () {
      try { return Math.round((localStorage.getItem(Store._lsKey()) || '').length / 1024 * 10) / 10; }
      catch (e) { return 0; }
    }
  };

  /* ─────────── Internes ─────────── */

  function normaliseCat(r) {
    if (!r || typeof r.id !== 'string' || !r.id) return null;
    return {
      id: r.id,
      label: String(r.label || 'Sans nom').slice(0, 40),
      color: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : COULEURS[0],
      ordre: Number.isFinite(r.ordre) ? r.ordre : 0,
      createdAt: r.createdAt || 0,
      updatedAt: r.updatedAt || 0,
      deleted: r.deleted ? 1 : 0
    };
  }

  function normalise(r) {
    return {
      id: r.id, title: r.title || 'Sans titre', notes: r.notes || '', location: r.location || '',
      date: r.date, endDate: r.endDate || null, allDay: !!r.allDay,
      startTime: r.allDay ? null : (r.startTime || null),
      endTime: r.allDay ? null : (r.endTime || null),
      cat: r.cat || 'perso', important: !!r.important, done: !!r.done,
      repeat: r.repeat || 'none',
      skip: Array.isArray(r.skip) ? r.skip : (r.skip ? String(r.skip).split(',') : []),
      createdAt: r.createdAt || Date.now(),
      updatedAt: r.updatedAt || Date.now(),
      deleted: r.deleted ? 1 : 0
    };
  }

  function passeFiltres(ev, f) {
    if (!f) return true;
    if (f.cats && f.cats.length && f.cats.indexOf(ev.cat) === -1) return false;
    if (f.important && !ev.important) return false;
    if (f.undone && ev.done) return false;
    return true;
  }

  /** n-ième occurrence, toujours calculée depuis la date d'origine
      (évite la dérive du 31 janvier -> 28 février -> 28 mars) */
  function occurrenceN(ev, n) {
    switch (ev.repeat) {
      case 'daily':   return D.addDays(ev.date, n);
      case 'weekly':  return D.addDays(ev.date, n * 7);
      case 'monthly': return D.addMonths(ev.date, n);
      case 'yearly':  return D.addMonths(ev.date, n * 12);
      default:        return ev.date;
    }
  }

  /** Dates de début d'occurrence tombant dans [from-span, to] */
  function departsDansPlage(ev, from, to, span) {
    var borneBasse = span ? D.addDays(from, -span) : from;

    if (ev.repeat === 'none' || !ev.repeat) {
      return (ev.date >= borneBasse && ev.date <= to) ? [ev.date] : [];
    }
    if (ev.date > to) return [];

    // Saut direct jusqu'aux environs de la borne basse (jamais au-delà)
    var n0 = 0, a, b;
    if (ev.repeat === 'daily') {
      n0 = D.diff(ev.date, borneBasse);
    } else if (ev.repeat === 'weekly') {
      n0 = Math.floor(D.diff(ev.date, borneBasse) / 7);
    } else if (ev.repeat === 'monthly') {
      a = D.parse(ev.date); b = D.parse(borneBasse);
      n0 = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - 1;
    } else if (ev.repeat === 'yearly') {
      n0 = D.parse(borneBasse).getFullYear() - D.parse(ev.date).getFullYear() - 1;
    }
    if (n0 < 0) n0 = 0;

    var out = [], garde = 0;
    for (var n = n0; garde++ < 500; n++) {
      var d = occurrenceN(ev, n);
      if (d > to) break;
      if (d >= borneBasse) out.push(d);
    }
    return out;
  }

  /** Journée entière et multi-jours d'abord, puis par heure, puis par titre */
  function triOccurrences(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    var aFull = a.ev.allDay || a.multi, bFull = b.ev.allDay || b.multi;
    if (aFull !== bFull) return aFull ? -1 : 1;
    if (!aFull) {
      var d = D.mins(a.ev.startTime) - D.mins(b.ev.startTime);
      if (d) return d;
    }
    return a.ev.title.localeCompare(b.ev.title, 'fr');
  }

  global.Dates = D;
  global.Store = Store;
})(window);
