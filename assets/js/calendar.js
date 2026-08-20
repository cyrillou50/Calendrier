/* ═══════════════════════════════════════════════════════════
   calendar.js — rendu des vues Mois / Semaine / Jour / Agenda
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var D = global.Dates;
  var HAUTEUR_H = 52;              // hauteur d'une heure, en px (voir --tgrid dans le CSS)
  var DOWS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  var Cal = {
    vue: 'month',
    ancre: D.today(),        // date pilotant la période affichée
    selection: D.today(),    // jour sélectionné
    miniAncre: D.today(),    // mois du mini-calendrier
    filtres: { cats: [], important: false, undone: false },

    /* ─────────── Navigation ─────────── */
    setVue: function (v) {
      Cal.vue = v;
      Cal.render();
    },

    aller: function (ymd) {
      Cal.selection = ymd;
      Cal.ancre = ymd;
      Cal.miniAncre = ymd;
      Cal.render();
    },

    pas: function (dir) {
      if (Cal.vue === 'week') Cal.ancre = D.addDays(Cal.ancre, 7 * dir);
      else if (Cal.vue === 'day') Cal.ancre = D.addDays(Cal.ancre, dir);
      else Cal.ancre = D.addMonths(D.startOfMonth(Cal.ancre), dir);
      if (Cal.vue === 'day') Cal.selection = Cal.ancre;
      Cal.miniAncre = Cal.ancre;
      Cal.render();
    },

    /** Plage [from, to] couverte par la vue courante */
    plage: function () {
      if (Cal.vue === 'week') {
        var l = D.startOfWeek(Cal.ancre);
        return [l, D.addDays(l, 6)];
      }
      if (Cal.vue === 'day') return [Cal.ancre, Cal.ancre];
      var d1 = D.startOfMonth(Cal.ancre);
      var d = D.parse(d1);
      var fin = D.ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
      if (Cal.vue === 'agenda') return [d1, fin];
      return [D.startOfWeek(d1), D.addDays(D.startOfWeek(d1), 41)];
    },

    libellePeriode: function () {
      if (Cal.vue === 'day') return D.longDate(Cal.ancre);
      if (Cal.vue === 'week') {
        var l = D.startOfWeek(Cal.ancre), f = D.addDays(l, 6);
        var a = D.parse(l), b = D.parse(f);
        var meme = a.getMonth() === b.getMonth();
        return (meme
          ? a.getDate() + ' – ' + b.getDate() + ' ' + D.MOIS[b.getMonth()]
          : a.getDate() + ' ' + D.MOIS_C[a.getMonth()] + ' – ' + b.getDate() + ' ' + D.MOIS_C[b.getMonth()])
          + ' ' + b.getFullYear() + '  ·  S' + D.week(l);
      }
      return D.monthYear(Cal.ancre);
    },

    /* ─────────── Rendu global ─────────── */
    render: function () {
      var lbl = document.querySelector('[data-period]');
      if (lbl) lbl.textContent = Cal.libellePeriode();

      var btns = document.querySelectorAll('.segmented__btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('is-active', btns[i].dataset.view === Cal.vue);
      }

      var vues = { month: '[data-view-month]', week: '[data-view-week]', day: '[data-view-day]', agenda: '[data-view-agenda]' };
      for (var k in vues) {
        var el = document.querySelector(vues[k]);
        if (el) el.hidden = (k !== Cal.vue);
      }

      if (Cal.vue === 'month')  Cal.rendreMois();
      if (Cal.vue === 'week')   Cal.rendreGrille(false);
      if (Cal.vue === 'day')    Cal.rendreGrille(true);
      if (Cal.vue === 'agenda') Cal.rendreAgenda();

      Cal.rendreMini();
      Cal.rendreCats();
      Cal.rendreAVenir();
    },

    /* ═════════════ VUE MOIS ═════════════ */
    rendreMois: function () {
      var hote = document.querySelector('[data-view-month]');
      if (!hote) return;

      var debut = D.startOfWeek(D.startOfMonth(Cal.ancre));
      var moisCourant = Cal.ancre.slice(0, 7);
      var aujourd = D.today();
      var occ = Store.occurrencesInRange(debut, D.addDays(debut, 41), Cal.filtres);
      var parJour = grouper(occ);

      var h = '<div class="mgrid"><div class="mgrid__dows">';
      for (var i = 0; i < 7; i++) h += '<div class="mgrid__dow">' + DOWS[i] + '</div>';
      h += '</div><div class="mgrid__body">';

      for (var s = 0; s < 6; s++) {
        h += '<div class="mgrid__week">';
        for (var j = 0; j < 7; j++) {
          var ymd = D.addDays(debut, s * 7 + j);
          var dehors = ymd.slice(0, 7) !== moisCourant;
          var cls = 'mday' + (dehors ? ' is-out' : '') +
                    (ymd === aujourd ? ' is-today' : '') +
                    (j >= 5 ? ' is-weekend' : '');
          var jourNum = D.parse(ymd).getDate();
          var liste = parJour[ymd] || [];

          h += '<div class="' + cls + '" data-day="' + ymd + '">' +
                 '<div class="mday__head">' +
                   '<span class="mday__num">' + jourNum + '</span>' +
                   '<span class="mday__add" data-add="' + ymd + '" title="Ajouter"><i data-ico="plus"></i></span>' +
                 '</div>' +
                 '<div class="mday__list" data-list="' + ymd + '">';

          for (var e = 0; e < liste.length; e++) h += pastille(liste[e]);

          h += '</div></div>';
        }
        h += '</div>';
      }
      h += '</div></div>';

      hote.innerHTML = h;
      Icons.render(hote);
      requestAnimationFrame(Cal.ajusterMois);
    },

    /** Masque les pastilles qui débordent et affiche « + N autres » */
    ajusterMois: function () {
      var listes = document.querySelectorAll('.mday__list');
      for (var i = 0; i < listes.length; i++) {
        var box = listes[i];
        var old = box.querySelector('.mday__more');
        if (old) box.removeChild(old);

        var enfants = box.children, dispo = box.clientHeight;
        if (!dispo) continue;

        for (var k = 0; k < enfants.length; k++) enfants[k].hidden = false;

        var cumul = 0, coupe = -1;
        for (var k2 = 0; k2 < enfants.length; k2++) {
          var hEl = enfants[k2].offsetHeight + 2;
          if (cumul + hEl > dispo && k2 < enfants.length) { coupe = k2; break; }
          cumul += hEl;
        }

        if (coupe !== -1) {
          // laisse la place à l'indicateur « + N »
          if (coupe > 0 && dispo - cumul < 18) coupe--;
          var reste = enfants.length - coupe;
          for (var m = coupe; m < enfants.length; m++) enfants[m].hidden = true;
          var more = document.createElement('button');
          more.className = 'mday__more';
          more.dataset.more = box.dataset.list;
          more.textContent = '+ ' + reste + ' autre' + (reste > 1 ? 's' : '');
          box.appendChild(more);
        }
      }
    },

    /* ═════════════ VUES SEMAINE / JOUR ═════════════ */
    rendreGrille: function (unSeulJour) {
      var hote = document.querySelector(unSeulJour ? '[data-view-day]' : '[data-view-week]');
      if (!hote) return;

      var jours = [];
      if (unSeulJour) jours.push(Cal.ancre);
      else {
        var l = D.startOfWeek(Cal.ancre);
        for (var i = 0; i < 7; i++) jours.push(D.addDays(l, i));
      }

      var aujourd = D.today();
      var occ = Store.occurrencesInRange(jours[0], jours[jours.length - 1], Cal.filtres);
      var parJour = grouper(occ);
      var cols = '58px repeat(' + jours.length + ', minmax(0,1fr))';

      /* En-tête */
      var h = '<div class="tgrid">';
      h += '<div class="tgrid__head" style="grid-template-columns:' + cols + '">';
      h += '<div class="tgrid__corner"></div>';
      for (var d = 0; d < jours.length; d++) {
        var ymd = jours[d], dt = D.parse(ymd);
        h += '<div class="tgrid__dayhead' + (ymd === aujourd ? ' is-today' : '') + '" data-day="' + ymd + '">' +
               '<div class="tgrid__dow">' + D.JOURS_C[dt.getDay()] + '</div>' +
               '<div class="tgrid__dnum">' + dt.getDate() + '</div>' +
             '</div>';
      }
      h += '</div>';

      /* Bandeau « journée entière » */
      var aDesToutJour = occ.some(function (o) { return o.ev.allDay || o.multi; });
      if (aDesToutJour) {
        h += '<div class="tgrid__allday" style="grid-template-columns:' + cols + '">';
        h += '<div class="tgrid__allday-label">Jour</div>';
        for (var a = 0; a < jours.length; a++) {
          h += '<div class="tgrid__allday-cell">';
          var lst = (parJour[jours[a]] || []).filter(function (o) { return o.ev.allDay || o.multi; });
          for (var q = 0; q < lst.length; q++) h += pastille(lst[q]);
          h += '</div>';
        }
        h += '</div>';
      }

      /* Corps horaire */
      h += '<div class="tgrid__scroll" data-scroll><div class="tgrid__body" style="grid-template-columns:' + cols + '">';
      h += '<div class="tgrid__hours">';
      for (var hh = 0; hh < 24; hh++) {
        h += '<div class="tgrid__hour"><span>' + (hh ? (hh < 10 ? '0' + hh : hh) + ':00' : '') + '</span></div>';
      }
      h += '</div>';

      for (var c = 0; c < jours.length; c++) {
        var jour = jours[c], dow = (D.parse(jour).getDay() + 6) % 7;
        h += '<div class="tgrid__col' + (dow >= 5 ? ' is-weekend' : '') + '" data-col="' + jour + '">';
        for (var sl = 0; sl < 24; sl++) {
          h += '<div class="tgrid__slot" data-slot="' + jour + '" data-hour="' + sl + '"></div>';
        }
        var minutes = (parJour[jour] || []).filter(function (o) { return !o.ev.allDay && !o.multi; });
        h += blocsHoraires(minutes);
        if (jour === aujourd) {
          var maintenant = new Date();
          var top = (maintenant.getHours() * 60 + maintenant.getMinutes()) / 60 * HAUTEUR_H;
          h += '<div class="now-line" style="top:' + top.toFixed(1) + 'px"></div>';
        }
        h += '</div>';
      }
      h += '</div></div></div>';

      hote.innerHTML = h;
      Icons.render(hote);

      // Cadre la vue sur 7h (ou l'heure courante) au premier rendu
      var sc = hote.querySelector('[data-scroll]');
      if (sc) {
        var ref = jours.indexOf(aujourd) !== -1 ? new Date().getHours() - 1 : 7;
        sc.scrollTop = Math.max(0, ref) * HAUTEUR_H;
      }
    },

    /* ═════════════ VUE AGENDA ═════════════ */
    rendreAgenda: function () {
      var hote = document.querySelector('[data-view-agenda]');
      if (!hote) return;

      var p = Cal.plage();
      var occ = Store.occurrencesInRange(p[0], p[1], Cal.filtres);
      // une seule ligne par occurrence : son premier jour visible dans la plage
      var vus = {};
      occ = occ.filter(function (o) {
        if (vus[o.key]) return false;
        vus[o.key] = 1;
        return true;
      });

      var parJour = grouper(occ);
      var jours = Object.keys(parJour).sort();
      var aujourd = D.today();

      if (!jours.length) {
        hote.innerHTML = '<div class="agenda"><div class="empty">' +
          '<i data-ico="inbox"></i><h3>Rien de prévu en ' + D.monthYear(Cal.ancre) + '</h3>' +
          '<p>Un mois tranquille — ou un mois à remplir.</p></div></div>';
        Icons.render(hote);
        return;
      }

      var h = '<div class="agenda"><div class="agenda__inner">';
      for (var i = 0; i < jours.length; i++) {
        var ymd = jours[i], dt = D.parse(ymd);
        h += '<div class="agenda__day' + (ymd === aujourd ? ' is-today' : '') + '">' +
               '<div class="agenda__date" data-day="' + ymd + '">' +
                 '<div class="agenda__dow">' + D.JOURS_C[dt.getDay()] + '</div>' +
                 '<div class="agenda__num">' + dt.getDate() + '</div>' +
                 '<div class="agenda__mon">' + D.MOIS_C[dt.getMonth()] + '</div>' +
               '</div><div class="agenda__items">';
        var lst = parJour[ymd];
        for (var k = 0; k < lst.length; k++) h += carte(lst[k]);
        h += '</div></div>';
      }
      h += '</div></div>';

      hote.innerHTML = h;
      Icons.render(hote);
    },

    /* ═════════════ MINI-CALENDRIER ═════════════ */
    rendreMini: function () {
      var hote = document.querySelector('[data-minical]');
      if (!hote) return;

      var debut = D.startOfWeek(D.startOfMonth(Cal.miniAncre));
      var mois = Cal.miniAncre.slice(0, 7);
      var aujourd = D.today();
      var occ = Store.occurrencesInRange(debut, D.addDays(debut, 41), Cal.filtres);
      var parJour = grouper(occ);

      var h = '<div class="minical__head">' +
                '<div class="minical__title">' + D.monthYear(Cal.miniAncre) + '</div>' +
                '<div class="minical__nav">' +
                  '<button class="icon-btn" data-mini="-1"><i data-ico="chev-l"></i></button>' +
                  '<button class="icon-btn" data-mini="1"><i data-ico="chev-r"></i></button>' +
                '</div></div><div class="minical__grid">';

      var mini = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
      for (var i = 0; i < 7; i++) h += '<div class="minical__dow">' + mini[i] + '</div>';

      for (var k = 0; k < 42; k++) {
        var ymd = D.addDays(debut, k);
        var cls = 'minical__day' +
          (ymd.slice(0, 7) !== mois ? ' is-out' : '') +
          (ymd === aujourd ? ' is-today' : '') +
          (ymd === Cal.selection ? ' is-sel' : '') +
          (parJour[ymd] ? ' has-ev' : '');
        h += '<button class="' + cls + '" data-day="' + ymd + '">' + D.parse(ymd).getDate() + '</button>';
      }
      h += '</div>';

      hote.innerHTML = h;
      Icons.render(hote);
    },

    /* ═════════════ CATÉGORIES ═════════════ */
    rendreCats: function () {
      var hote = document.querySelector('[data-cats]');
      if (!hote) return;
      var n = Store.countByCat();
      var actifs = Cal.filtres.cats;

      var h = '';
      for (var i = 0; i < Store.CATS.length; i++) {
        var c = Store.CATS[i];
        var off = actifs.length && actifs.indexOf(c.id) === -1;
        h += '<li><button class="' + (off ? 'is-off' : '') + '" data-cat="' + c.id + '">' +
               '<span class="cats__dot" style="background:' + c.color + '"></span>' +
               '<span>' + c.label + '</span>' +
               '<span class="cats__n">' + (n[c.id] || 0) + '</span>' +
             '</button></li>';
      }
      hote.innerHTML = h;
    },

    /* ═════════════ À VENIR ═════════════ */
    rendreAVenir: function () {
      var hote = document.querySelector('[data-upnext]');
      if (!hote) return;
      var liste = Store.upcoming(6, Cal.filtres);

      if (!liste.length) {
        hote.innerHTML = '<li class="upnext__empty">Rien à l’horizon.<br>Profites-en.</li>';
        return;
      }
      var h = '';
      for (var i = 0; i < liste.length; i++) {
        var o = liste[i], c = Store.cat(o.ev.cat);
        var heure = o.ev.allDay ? 'toute la journée' : o.ev.startTime;
        h += '<li data-ev="' + o.ev.id + '" data-occ="' + o.occStart + '">' +
               '<span class="upnext__bar" style="background:' + c.color + '"></span>' +
               '<span style="min-width:0;flex:1">' +
                 '<span class="upnext__t">' + (o.ev.important ? '★ ' : '') + UI.esc(o.ev.title) + '</span>' +
                 '<span class="upnext__d">' + D.relative(o.date) + ' · ' + heure + '</span>' +
               '</span></li>';
      }
      hote.innerHTML = h;
    }
  };

  /* ═════════════ Fabriques HTML ═════════════ */

  function grouper(occ) {
    var m = {};
    for (var i = 0; i < occ.length; i++) {
      (m[occ[i].date] || (m[occ[i].date] = [])).push(occ[i]);
    }
    return m;
  }

  /** Pastille compacte (vue mois, bandeau journée entière) */
  function pastille(o) {
    var ev = o.ev, c = Store.cat(ev.cat);
    var plein = ev.important;
    var style = UI.styleCouleur(c.color, plein);
    var heure = (!ev.allDay && !o.multi && ev.startTime) ? '<span class="pill__time">' + ev.startTime + '</span>' : '';
    var suite = o.multi && !o.isStart ? '← ' : '';
    return '<div class="pill' + (ev.done ? ' is-done' : '') + '" style="' + style + '" ' +
             'data-ev="' + ev.id + '" data-occ="' + o.occStart + '" title="' + UI.esc(ev.title) + '">' +
             heure +
             (ev.important ? '<i class="pill__star" data-ico="star"></i>' : '') +
             '<span class="pill__t">' + suite + UI.esc(ev.title) + '</span>' +
           '</div>';
  }

  /** Blocs positionnés dans la grille horaire, avec gestion des chevauchements */
  function blocsHoraires(liste) {
    if (!liste.length) return '';

    var items = liste.map(function (o) {
      var deb = D.mins(o.ev.startTime || '09:00');
      var fin = o.ev.endTime ? D.mins(o.ev.endTime) : deb + 60;
      if (fin <= deb) fin = deb + 30;
      return { o: o, deb: deb, fin: fin, col: 0, nb: 1 };
    }).sort(function (a, b) { return a.deb - b.deb || b.fin - a.fin; });

    // Regroupe en grappes de blocs qui se chevauchent, puis répartit en colonnes
    var grappe = [], finGrappe = -1;
    for (var i = 0; i < items.length; i++) {
      if (grappe.length && items[i].deb >= finGrappe) { placer(grappe); grappe = []; finGrappe = -1; }
      grappe.push(items[i]);
      finGrappe = Math.max(finGrappe, items[i].fin);
    }
    if (grappe.length) placer(grappe);

    function placer(g) {
      var colonnes = [];
      for (var k = 0; k < g.length; k++) {
        var pose = false;
        for (var c = 0; c < colonnes.length; c++) {
          if (colonnes[c] <= g[k].deb) { g[k].col = c; colonnes[c] = g[k].fin; pose = true; break; }
        }
        if (!pose) { g[k].col = colonnes.length; colonnes.push(g[k].fin); }
      }
      for (var m = 0; m < g.length; m++) g[m].nb = colonnes.length;
    }

    var h = '';
    for (var n = 0; n < items.length; n++) {
      var it = items[n], ev = it.o.ev, cat = Store.cat(ev.cat);
      var top = it.deb / 60 * HAUTEUR_H;
      var haut = Math.max(20, (it.fin - it.deb) / 60 * HAUTEUR_H - 2);
      var largeur = 100 / it.nb;
      var gauche = it.col * largeur;
      var court = haut < 40;

      h += '<div class="tev' + (ev.done ? ' is-done' : '') + (court ? ' tev--short' : '') + '" ' +
             'style="' + UI.styleCouleur(cat.color, ev.important) +
             ';top:' + top.toFixed(1) + 'px;height:' + haut.toFixed(1) + 'px' +
             ';left:calc(' + gauche + '% + 2px);width:calc(' + largeur + '% - 4px)" ' +
             'data-ev="' + ev.id + '" data-occ="' + it.o.occStart + '" ' +
             'title="' + UI.esc(ev.title) + ' · ' + ev.startTime + (ev.endTime ? '–' + ev.endTime : '') + '">' +
             '<div class="tev__t">' + (ev.important ? '★ ' : '') + UI.esc(ev.title) + '</div>' +
             '<div class="tev__h">' + ev.startTime + (ev.endTime ? ' – ' + ev.endTime : '') + '</div>' +
             (!court && ev.location ? '<div class="tev__loc">' + UI.esc(ev.location) + '</div>' : '') +
           '</div>';
    }
    return h;
  }

  /** Carte détaillée (vue agenda, modale du jour) */
  function carte(o) {
    var ev = o.ev, c = Store.cat(ev.cat);
    var meta = [];
    if (ev.allDay) meta.push('<span><i data-ico="clock"></i>Toute la journée</span>');
    else meta.push('<span><i data-ico="clock"></i>' + ev.startTime + (ev.endTime ? ' – ' + ev.endTime : '') + '</span>');
    if (o.multi) meta.push('<span><i data-ico="cal"></i>jusqu’au ' + D.shortDate(o.occEnd) + '</span>');
    if (ev.location) meta.push('<span><i data-ico="pin"></i>' + UI.esc(ev.location) + '</span>');
    if (ev.repeat && ev.repeat !== 'none') meta.push('<span><i data-ico="repeat"></i>' + libelleRepet(ev.repeat) + '</span>');
    meta.push('<span><i data-ico="note"></i>' + c.label + '</span>');

    return '<div class="acard' + (ev.done ? ' is-done' : '') + '" data-ev="' + ev.id + '" data-occ="' + o.occStart + '">' +
             '<span class="acard__bar" style="background:' + c.color + '"></span>' +
             '<div class="acard__body">' +
               '<div class="acard__top">' +
                 '<span class="acard__t">' + UI.esc(ev.title) + '</span>' +
                 (ev.important ? '<span class="tag tag--imp">Important</span>' : '') +
               '</div>' +
               '<div class="acard__meta">' + meta.join('') + '</div>' +
               (ev.notes ? '<div class="acard__notes">' + UI.esc(ev.notes) + '</div>' : '') +
             '</div>' +
             '<button class="acard__check" data-toggle="' + ev.id + '" title="Marquer comme terminé"><i data-ico="check"></i></button>' +
           '</div>';
  }

  function libelleRepet(r) {
    return { daily: 'chaque jour', weekly: 'chaque semaine', monthly: 'chaque mois', yearly: 'chaque année' }[r] || '';
  }

  Cal.carte = carte;
  Cal.HAUTEUR_H = HAUTEUR_H;
  global.Cal = Cal;
})(window);
