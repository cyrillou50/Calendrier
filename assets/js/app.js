/* ═══════════════════════════════════════════════════════════
   app.js — démarrage, interactions, connexion, synchronisation
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var D = global.Dates;
  var K_THEME = 'calendrier:theme';
  var K_MODE  = 'calendrier:mode';   // 'local' | 'compte'

  var App = {
    pret: false,
    minuteurSync: null,
    minuteurRecherche: null,
    minuteurPresence: null,
    minuteurMembres: null,
    presents: [],       // qui d'autre est sur le calendrier affiché
    codeInvite: null,
    jourOuvert: null,
    occCourante: null   // occurrence en cours d'édition { id, date }
  };

  /* ═════════════════ THÈME ═════════════════ */
  function themeInit() {
    var t = null;
    try { t = localStorage.getItem(K_THEME); } catch (e) {}
    if (!t) t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    themeAppliquer(t);
  }
  function themeAppliquer(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(K_THEME, t); } catch (e) {}
    var meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = t === 'light' ? '#F5F7FC' : '#0B0F1A';
    var icones = document.querySelectorAll('[data-action="theme"] i[data-ico]');
    for (var i = 0; i < icones.length; i++) {
      icones[i].dataset.ico = t === 'light' ? 'moon' : 'sun';
    }
    Icons.render();
  }
  function themeBascule() {
    themeAppliquer(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  }

  /* ═════════════════ DÉMARRAGE ═════════════════ */
  function demarrer() {
    themeInit();
    Icons.render();
    Api.load();
    brancherGlobal();
    brancherActions();   // toutes les [data-action], y compris dans les modales
    brancherModales();   // les modales servent aussi depuis l'écran de connexion
    brancherClavier();

    var mode = null;
    try { mode = localStorage.getItem(K_MODE); } catch (e) {}

    if (Api.authed()) {
      ouvrirApp(Api.calendrier || Api.user.id, Api.user);
      // vérifie la session en arrière-plan, sans bloquer
      Api.me().then(function () { synchroniser(true); })
             .catch(function (e) {
               if (e.code === 'UNAUTH') { UI.err('Session expirée.'); deconnexion(true); }
               else majPastilleSync('error');
             });
    } else if (mode === 'local') {
      ouvrirApp('local', null);
    } else {
      ouvrirAuth();
    }
  }

  function ouvrirAuth() {
    document.getElementById('app').hidden = true;
    var ecran = document.getElementById('authScreen');
    ecran.hidden = false;
    brancherAuth();
    Icons.render(ecran);
  }

  function ouvrirApp(cle, utilisateur) {
    document.getElementById('authScreen').hidden = true;
    document.getElementById('app').hidden = false;

    Store.open(cle);
    Cal.ancre = D.today();
    Cal.selection = D.today();
    Cal.miniAncre = D.today();
    Cal.render();

    var av = document.querySelector('[data-avatar]');
    if (av) av.textContent = utilisateur ? UI.initiales(utilisateur.pseudo) : '·';
    majEtatSync();
    majCalendriers();
    majDroits();
    demarrerPresence();

    if (!App.pret) { brancherApp(); App.pret = true; }
    Icons.render();
  }

  /* ═════════════════ CALENDRIERS PARTAGÉS ═════════════════ */

  /** Met à jour le bouton de la barre du haut et le contenu du menu */
  function majCalendriers() {
    var menu = document.querySelector('[data-calmenu]');
    var nom = document.querySelector('[data-cal-nom]');
    if (!menu || !nom) return;

    // Toujours visible une fois connecté : c'est aussi le point d'entrée
    // pour rejoindre un calendrier, même quand on n'en a qu'un.
    menu.hidden = !Api.authed();

    var actuel = Api.calendrierActuel();
    nom.textContent = !actuel || actuel.role === 'proprietaire'
      ? 'Mon calendrier'
      : 'Calendrier de ' + actuel.pseudo;

    rendreMenuCalendriers();
  }

  function rendreMenuCalendriers() {
    var pop = document.querySelector('[data-calmenu-pop]');
    if (!pop) return;

    var liste = Api.calendriers || [];
    var h = '<div class="calmenu__titre">Calendriers</div>';

    for (var i = 0; i < liste.length; i++) {
      var c = liste[i];
      var moi = c.role === 'proprietaire';
      var titre = moi ? 'Mon calendrier' : 'Calendrier de ' + c.pseudo;
      var sousTitre = moi ? 'À toi'
        : (c.role === 'lecture' ? 'Lecture seule' : 'Tu peux modifier');
      var actif = c.id === Api.calendrier;

      h += '<button class="calmenu__item' + (actif ? ' is-active' : '') + '" ' +
             'data-action="cal-choisir" data-cal="' + UI.esc(c.id) + '">' +
             '<span class="calmenu__av' + (moi ? ' calmenu__av--moi' : '') + '">' +
               UI.esc(moi ? '★' : UI.initiales(c.pseudo)) + '</span>' +
             '<span style="min-width:0">' +
               '<span class="calmenu__n">' + UI.esc(titre) + '</span>' +
               '<span class="calmenu__r">' + sousTitre + '</span>' +
             '</span>' +
             (actif ? '<i class="calmenu__check" data-ico="check"></i>' : '') +
           '</button>';
    }

    h += '<div class="calmenu__sep"></div>' +
         '<button class="calmenu__item calmenu__item--action" data-action="rejoindre">' +
           '<i data-ico="plus"></i> Rejoindre avec un code…</button>' +
         '<button class="calmenu__item calmenu__item--action" data-action="inviter">' +
           '<i data-ico="users"></i> Inviter quelqu’un sur le mien…</button>';

    pop.innerHTML = h;
    Icons.render(pop);
  }

  function ouvrirMenuCalendriers() {
    var menu = document.querySelector('[data-calmenu]');
    var pop = document.querySelector('[data-calmenu-pop]');
    if (!menu || !pop) return;
    var ouvert = pop.hidden;
    if (ouvert) rendreMenuCalendriers();
    pop.hidden = !ouvert;
    menu.classList.toggle('is-open', ouvert);
  }

  function fermerMenuCalendriers() {
    var menu = document.querySelector('[data-calmenu]');
    var pop = document.querySelector('[data-calmenu-pop]');
    if (pop) pop.hidden = true;
    if (menu) menu.classList.remove('is-open');
  }

  /** Bascule vers un autre calendrier */
  function changerCalendrier(id) {
    if (!id || id === Api.calendrier) return;

    function basculer() {
      Api.setCalendrier(id);
      Store.open(id);
      Cal.render();
      majCalendriers();
      majDroits();
      majEtatSync();
      var c = Api.calendrierActuel();
      UI.info(c && c.role === 'proprietaire'
        ? 'Ton calendrier'
        : 'Calendrier de ' + (c ? c.pseudo : '?'));
      App.presents = [];
      majPresenceBouton();
      synchroniser(true);
      battre();                 // on annonce sa présence sur le nouveau calendrier
    }

    // On termine la synchro en cours AVANT de changer d'espace de stockage,
    // sinon sa réponse s'écrirait dans le mauvais calendrier.
    var p = synchroniser(true);
    if (p && p.then) p.then(basculer, basculer);
    else basculer();
  }

  /** Adapte l'interface au droit d'écriture sur le calendrier affiché */
  function majDroits() {
    var peut = Api.peutEcrire();
    document.body.classList.toggle('is-readonly', !peut);

    var creer = document.querySelectorAll('[data-action="new-event"]');
    for (var i = 0; i < creer.length; i++) creer[i].hidden = !peut;

    // Le bandeau se place entre la barre du haut et la mise en page,
    // qui est en colonne : l'insérer dans .layout casserait la grille.
    var layout = document.querySelector('.layout');
    var bandeau = document.querySelector('[data-readonly-banner]');
    if (!peut && !bandeau && layout && layout.parentNode) {
      bandeau = document.createElement('div');
      bandeau.className = 'readonly';
      bandeau.setAttribute('data-readonly-banner', '');
      bandeau.innerHTML = '<i data-ico="eye"></i> Lecture seule — tu ne peux pas modifier ce calendrier';
      layout.parentNode.insertBefore(bandeau, layout);
      Icons.render(bandeau);
    } else if (peut && bandeau) {
      bandeau.remove();
    }
  }

  /* ═════════════════ ÉCRAN DE CONNEXION ═════════════════ */
  var authBranche = false;
  function brancherAuth() {
    if (authBranche) return;
    authBranche = true;
    var ecran = document.getElementById('authScreen');

    // Les [data-action] sont traités globalement (voir brancherActions) :
    // ici, seuls les onglets propres à cet écran.
    ecran.addEventListener('click', function (e) {
      var onglet = e.target.closest('[data-tab]');
      if (onglet) return basculerOnglet(onglet.dataset.tab);
    });

    // Jauge de robustesse du mot de passe
    var mdp = ecran.querySelector('#registerForm input[name=password]');
    if (mdp) mdp.addEventListener('input', function () { jauge(mdp.value); });

    ecran.querySelector('#loginForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      soumettre(f, Api.login(f.elements.pseudo.value.trim(), f.elements.password.value), 'Connexion…');
    });

    ecran.querySelector('#registerForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var pseudo = f.elements.pseudo.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,18}[A-Za-z0-9]$/.test(pseudo)) {
        return erreurForm(f, 'Pseudo invalide : 3 à 20 caractères, lettres, chiffres, point, tiret ou souligné.');
      }
      if (f.elements.password.value.length < 8) return erreurForm(f, 'Le mot de passe doit faire au moins 8 caractères.');
      soumettre(f, Api.register(pseudo, f.elements.password.value), 'Création…');
    });
  }

  /** Affiche ou masque le mot de passe du champ voisin */
  function basculerVisibilite(bouton) {
    var champ = bouton.parentNode.querySelector('input');
    if (!champ) return;
    var cache = champ.type === 'password';
    champ.type = cache ? 'text' : 'password';
    var ico = bouton.querySelector('i');
    if (ico) { ico.dataset.ico = cache ? 'eye-off' : 'eye'; Icons.render(bouton); }
  }

  function basculerOnglet(nom) {
    var ecran = document.getElementById('authScreen');
    var onglets = ecran.querySelectorAll('[data-tab]');
    for (var i = 0; i < onglets.length; i++) {
      onglets[i].classList.toggle('is-active', onglets[i].dataset.tab === nom);
    }
    var volets = ecran.querySelectorAll('[data-pane]');
    for (var k = 0; k < volets.length; k++) {
      volets[k].hidden = volets[k].dataset.pane !== nom;
    }
  }

  function soumettre(form, promesse, texteAttente) {
    if (!Api.configured()) {
      promesse.catch(function () {});   // évite une promesse rejetée sans gestionnaire
      erreurForm(form, "Aucun serveur n'est configuré. Renseigne l'adresse de ton VPS, ou continue sans compte.");
      return;
    }
    var btn = form.querySelector('button[type=submit]');
    var libelle = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>' + texteAttente + '</span>';
    cacherErreur(form);

    promesse.then(function (utilisateur) {
      try { localStorage.setItem(K_MODE, 'compte'); } catch (e) {}
      return migrerDonneesLocales(utilisateur).then(function () {
        ouvrirApp(utilisateur.id, utilisateur);
        UI.ok('Bienvenue, ' + utilisateur.pseudo + ' !');
        synchroniser(true);
      });
    }).catch(function (e) {
      erreurForm(form, e.message || 'Une erreur est survenue.');
    }).then(function () {
      btn.disabled = false;
      btn.innerHTML = libelle;
    });
  }

  /** Propose de rapatrier les données du mode local dans le compte */
  function migrerDonneesLocales(utilisateur) {
    var brut;
    try { brut = localStorage.getItem('calendrier:v1:local'); } catch (e) { return Promise.resolve(); }
    if (!brut) return Promise.resolve();

    var locales;
    try { locales = JSON.parse(brut).events || {}; } catch (e) { return Promise.resolve(); }
    var vivants = Object.keys(locales).filter(function (id) { return !locales[id].deleted; });
    if (!vivants.length) return Promise.resolve();

    return UI.confirm({
      titre: 'Récupérer tes données locales ?',
      texte: 'Cet appareil contient ' + vivants.length + ' événement' + (vivants.length > 1 ? 's' : '') +
             ' enregistré' + (vivants.length > 1 ? 's' : '') + ' sans compte. Veux-tu les rattacher à ton compte ?',
      actions: [{ id: 'oui', label: 'Récupérer', style: 'btn--primary' }]
    }).then(function (r) {
      if (r !== 'oui') return;
      Store.open(utilisateur.id);
      Store.importData({ events: vivants.map(function (id) { return locales[id]; }) });
    });
  }

  function modeLocal() {
    try { localStorage.setItem(K_MODE, 'local'); } catch (e) {}
    ouvrirApp('local', null);
    UI.info('Mode local : tes données restent dans ce navigateur.');
  }

  function jauge(v) {
    var ecran = document.getElementById('authScreen');
    var barre = ecran.querySelector('[data-meter]');
    var lbl = ecran.querySelector('[data-meter-label]');
    var s = 0;
    if (v.length >= 8) s++;
    if (v.length >= 12) s++;
    if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++;
    if (/\d/.test(v)) s++;
    if (/[^\w\s]/.test(v)) s++;

    var niveaux = [
      { p: 0,   c: 'transparent',   t: 'Force du mot de passe' },
      { p: 20,  c: 'var(--danger)', t: 'Très faible' },
      { p: 40,  c: 'var(--danger)', t: 'Faible' },
      { p: 60,  c: 'var(--warn)',   t: 'Correct' },
      { p: 80,  c: 'var(--ok)',     t: 'Bon' },
      { p: 100, c: 'var(--ok)',     t: 'Excellent' }
    ];
    var n = niveaux[Math.min(s, 5)];
    barre.style.width = n.p + '%';
    barre.style.background = n.c;
    lbl.textContent = n.t;
  }

  function erreurForm(form, msg) {
    var p = form.querySelector('[data-error]');
    if (!p) return UI.err(msg);
    p.textContent = msg;
    p.hidden = false;
  }
  function cacherErreur(form) {
    var p = form.querySelector('[data-error]');
    if (p) p.hidden = true;
  }

  /* ═════════════════ INTERACTIONS DE L'APPLICATION ═════════════════ */
  function brancherApp() {
    var app = document.getElementById('app');

    app.addEventListener('click', function (e) {
      var t = e.target;
      // [data-action] est traité par brancherActions, au niveau du document
      if (t.closest('[data-action]')) return;

      var vue = t.closest('[data-view]');
      if (vue) return Cal.setVue(vue.dataset.view);

      var mini = t.closest('[data-mini]');
      if (mini) {
        Cal.miniAncre = D.addMonths(D.startOfMonth(Cal.miniAncre), +mini.dataset.mini);
        Cal.rendreMini();
        return;
      }

      var catBtn = t.closest('[data-cat]');
      if (catBtn) return basculerCat(catBtn.dataset.cat);

      var coche = t.closest('[data-toggle]');
      if (coche) {
        e.stopPropagation();
        if (!Api.peutEcrire()) return UI.err('Ce calendrier est en lecture seule.');
        Store.toggleDone(coche.dataset.toggle);
        Cal.render(); planifierSync();
        return;
      }

      var ajout = t.closest('[data-add]');
      if (ajout) {
        e.stopPropagation();
        if (!Api.peutEcrire()) return UI.err('Ce calendrier est en lecture seule.');
        return ouvrirEvenement(null, ajout.dataset.add);
      }

      var plus = t.closest('[data-more]');
      if (plus) { e.stopPropagation(); return ouvrirJour(plus.dataset.more); }

      var ev = t.closest('[data-ev]');
      if (ev) { e.stopPropagation(); return ouvrirEvenement(ev.dataset.ev, ev.dataset.occ); }

      var creneau = t.closest('[data-slot]');
      if (creneau) {
        if (!Api.peutEcrire()) return;
        var h = +creneau.dataset.hour;
        return ouvrirEvenement(null, creneau.dataset.slot, (h < 10 ? '0' : '') + h + ':00');
      }

      var jour = t.closest('[data-day]');
      if (jour) return cliquerJour(jour.dataset.day, jour);
    });

    // Filtres de la barre latérale
    var filtres = app.querySelectorAll('[data-filter]');
    for (var i = 0; i < filtres.length; i++) {
      filtres[i].addEventListener('change', function (e) {
        Cal.filtres[e.target.dataset.filter] = e.target.checked;
        Cal.render();
      });
    }

    // Recherche
    var recherche = document.getElementById('searchInput');
    recherche.addEventListener('input', function () {
      clearTimeout(App.minuteurRecherche);
      App.minuteurRecherche = setTimeout(function () { chercher(recherche.value); }, 140);
    });
    recherche.addEventListener('focus', function () { if (recherche.value) chercher(recherche.value); });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.search')) fermerRecherche();
      if (!e.target.closest('.calmenu')) fermerMenuCalendriers();
    });

    // Ligne « maintenant » et changement de jour
    setInterval(function () {
      if (Cal.vue === 'week' || Cal.vue === 'day') Cal.render();
    }, 60000);

    // Synchro à la reconnexion / au retour sur l'onglet
    global.addEventListener('online', function () { majEtatSync(); synchroniser(true); });
    global.addEventListener('offline', majEtatSync);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Api.authed()) { synchroniser(true); battre(); }
    });
    global.addEventListener('resize', function () {
      if (Cal.vue === 'month') Cal.ajusterMois();
    });
  }

  /**
   * Délégation des actions au niveau du DOCUMENT.
   * Indispensable : les modales sont hors de #app, donc un écouteur
   * posé sur #app ne les voit jamais.
   */
  function brancherActions() {
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (el) executer(el.dataset.action, el, e);
    });
  }

  function executer(nom, el, e) {
    switch (nom) {
      /* ── Écran de connexion ── */
      case 'peek':          return basculerVisibilite(el);
      case 'offline':       return modeLocal();

      /* ── Menu des calendriers ── */
      case 'cal-menu':      return ouvrirMenuCalendriers();
      case 'cal-choisir':   fermerMenuCalendriers(); return changerCalendrier(el.dataset.cal);

      case 'prev':   return Cal.pas(-1);
      case 'next':   return Cal.pas(1);
      case 'today':  return Cal.aller(D.today());
      case 'theme':  return themeBascule();
      case 'new-event': return ouvrirEvenement(null, Cal.selection);
      case 'new-event-here':
        UI.close('dayModal');
        return ouvrirEvenement(null, App.jourOuvert || Cal.selection);
      case 'toggle-sidebar': return basculerSidebar();
      case 'user-menu': return ouvrirCompte();
      case 'sync':   return synchroniser(false);
      case 'delete-event':  return supprimerEvenement();
      case 'logout': return deconnexion(false);
      case 'signin': return retourConnexion();

      /* ── Partage ── */
      case 'inviter':      fermerMenuCalendriers(); return creerInvitation();
      case 'rejoindre':    fermerMenuCalendriers(); return rejoindreCalendrier();
      case 'copier-code':  return copierCode();
      case 'retirer':      return retirerAcces(el.dataset.cal, el.dataset.membre, el.dataset.nom);
      case 'annuler-invit':return annulerInvitation(el.dataset.code);
      case 'export':        return exporterJson();
      case 'import':        return document.getElementById('importFile').click();
      case 'ics':           return exporterIcs();
    }
  }

  function cliquerJour(ymd, el) {
    Cal.selection = ymd;
    if (Cal.vue === 'month') {
      if (el.classList.contains('mday') && !el.closest('.minical')) {
        // clic sur une case du mois : ouvre le détail si le jour a des événements
        var n = Store.onDay(ymd, Cal.filtres).length;
        if (n) return ouvrirJour(ymd);
        if (!Api.peutEcrire()) return;      // jour vide, calendrier en lecture seule
        return ouvrirEvenement(null, ymd);
      }
      Cal.miniAncre = ymd;
      Cal.ancre = ymd;
      return Cal.render();
    }
    if (el.closest('.minical') || el.closest('.agenda__date') || el.closest('.tgrid__dayhead')) {
      Cal.ancre = ymd; Cal.miniAncre = ymd;
      if (el.closest('.tgrid__dayhead')) Cal.vue = 'day';
      return Cal.render();
    }
    Cal.render();
  }

  function basculerCat(id) {
    var i = Cal.filtres.cats.indexOf(id);
    if (Cal.filtres.cats.length === 0) {
      // premier clic : isole la catégorie
      Cal.filtres.cats = [id];
    } else if (i === -1) {
      Cal.filtres.cats.push(id);
    } else {
      Cal.filtres.cats.splice(i, 1);
    }
    if (Cal.filtres.cats.length === Store.CATS.length) Cal.filtres.cats = [];
    Cal.render();
  }

  function basculerSidebar() {
    var s = document.querySelector('[data-sidebar]');
    var scrim = document.querySelector('[data-scrim]');
    var ouvert = s.classList.toggle('is-open');
    if (scrim) scrim.hidden = !ouvert;
  }

  /* ═════════════════ MODALE ÉVÉNEMENT ═════════════════ */
  function brancherModales() {
    document.addEventListener('click', function (e) {
      var fermer = e.target.closest('[data-close]');
      if (fermer) {
        var modale = fermer.closest('.modal');
        if (modale) UI.close(modale.id);
        return;
      }
      var scrim = e.target.closest('[data-scrim]');
      if (scrim) basculerSidebar();
    });

    var form = document.getElementById('eventForm');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      enregistrerEvenement(form);
    });

    form.elements.allDay.addEventListener('change', function () {
      document.querySelector('[data-times]').hidden = form.elements.allDay.checked;
    });

    // Ajuste l'heure de fin quand on change l'heure de début
    form.elements.startTime.addEventListener('change', function () {
      if (!form.elements.endTime.value || D.mins(form.elements.endTime.value) <= D.mins(form.elements.startTime.value)) {
        form.elements.endTime.value = D.hhmm(Math.min(23 * 60 + 59, D.mins(form.elements.startTime.value) + 60));
      }
    });

    // Pastilles de catégorie
    document.querySelector('[data-swatches]').addEventListener('click', function (e) {
      var s = e.target.closest('[data-swatch]');
      if (!s) return;
      choisirCat(s.dataset.swatch);
    });

    // Import de fichier
    document.getElementById('importFile').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var lecteur = new FileReader();
      lecteur.onload = function () {
        try {
          var n = Store.importData(JSON.parse(lecteur.result));
          Cal.render();
          UI.ok(n + ' événement' + (n > 1 ? 's' : '') + ' importé' + (n > 1 ? 's' : ''));
          planifierSync();
        } catch (err) {
          UI.err('Fichier illisible : ' + err.message);
        }
      };
      lecteur.readAsText(f);
      e.target.value = '';
    });

  }

  function rendreSwatches(actif) {
    var hote = document.querySelector('[data-swatches]');
    var h = '';
    for (var i = 0; i < Store.CATS.length; i++) {
      var c = Store.CATS[i];
      h += '<button type="button" class="swatch' + (c.id === actif ? ' is-active' : '') + '" ' +
             'style="--_c:' + c.color + '" data-swatch="' + c.id + '"><i></i>' + c.label + '</button>';
    }
    hote.innerHTML = h;
  }
  function choisirCat(id) {
    document.getElementById('eventForm').dataset.cat = id;
    rendreSwatches(id);
  }

  function ouvrirEvenement(id, ymd, heure) {
    var form = document.getElementById('eventForm');
    form.reset();
    var ev = id ? Store.get(id) : null;

    document.querySelector('[data-modal-title]').textContent = ev ? 'Modifier l’événement' : 'Nouvel événement';
    document.querySelector('[data-action="delete-event"]').hidden = !ev;
    App.occCourante = ev ? { id: ev.id, date: ymd || ev.date } : null;

    // Rappel : les récurrences se modifient au niveau de la série
    var ancienneNote = form.querySelector('[data-serie-note]');
    if (ancienneNote) ancienneNote.remove();

    if (ev) {
      form.elements.id.value = ev.id;
      form.elements.title.value = ev.title;
      form.elements.date.value = ev.date;
      form.elements.endDate.value = ev.endDate || '';
      form.elements.allDay.checked = ev.allDay;
      form.elements.startTime.value = ev.startTime || '09:00';
      form.elements.endTime.value = ev.endTime || '';
      form.elements.repeat.value = ev.repeat || 'none';
      form.elements.location.value = ev.location || '';
      form.elements.notes.value = ev.notes || '';
      form.elements.important.checked = ev.important;
      form.elements.done.checked = ev.done;
      choisirCat(ev.cat);

      if (ev.repeat && ev.repeat !== 'none' && ymd && ymd !== ev.date) {
        var note = document.createElement('p');
        note.className = 'note';
        note.setAttribute('data-serie-note', '');
        note.innerHTML = '<i data-ico="repeat"></i><span>Occurrence du <b>' + D.longDate(ymd) +
          '</b>. Les modifications s’appliquent à toute la série.</span>';
        var hero = form.querySelector('.field--hero');
        form.insertBefore(note, hero ? hero.nextSibling : form.firstChild);
        Icons.render(note);
      }
    } else {
      form.elements.id.value = '';
      form.elements.date.value = ymd || D.today();
      form.elements.startTime.value = heure || prochainCreneau();
      form.elements.endTime.value = D.hhmm(Math.min(23 * 60 + 59, D.mins(form.elements.startTime.value) + 60));
      form.elements.repeat.value = 'none';
      choisirCat('perso');
    }

    document.querySelector('[data-times]').hidden = form.elements.allDay.checked;

    // Calendrier en lecture seule : consultation possible, modification non
    var peut = Api.peutEcrire();
    for (var k = 0; k < form.elements.length; k++) form.elements[k].disabled = !peut;
    var enregistrer = document.querySelector('#eventModal button[type=submit]');
    if (enregistrer) enregistrer.hidden = !peut;
    if (!peut) document.querySelector('[data-action="delete-event"]').hidden = true;

    UI.open('eventModal');
    if (peut) setTimeout(function () { form.elements.title.focus(); }, 80);
  }

  function prochainCreneau() {
    var d = new Date();
    var m = Math.ceil((d.getHours() * 60 + d.getMinutes()) / 30) * 30;
    return D.hhmm(Math.min(23 * 60 + 30, m));
  }

  function enregistrerEvenement(form) {
    if (!Api.peutEcrire()) return UI.err('Ce calendrier est en lecture seule.');
    if (!form.elements.title.value.trim()) {
      form.elements.title.focus();
      return UI.err('Donne un titre à ton événement.');
    }
    if (!form.elements.date.value) {
      return UI.err('Choisis une date.');
    }

    var nouveau = !form.elements.id.value;
    Store.upsert({
      id: form.elements.id.value || null,
      title: form.elements.title.value,
      date: form.elements.date.value,
      endDate: form.elements.endDate.value || null,
      allDay: form.elements.allDay.checked,
      startTime: form.elements.startTime.value,
      endTime: form.elements.endTime.value,
      cat: form.dataset.cat || 'perso',
      repeat: form.elements.repeat.value,
      location: form.elements.location.value,
      notes: form.elements.notes.value,
      important: form.elements.important.checked,
      done: form.elements.done.checked
    });

    UI.close('eventModal');
    Cal.selection = form.elements.date.value;
    Cal.render();
    UI.ok(nouveau ? 'Événement ajouté' : 'Modifications enregistrées');
    planifierSync();
  }

  function supprimerEvenement() {
    var form = document.getElementById('eventForm');
    var id = form.elements.id.value;
    if (!id) return;
    var ev = Store.get(id);
    if (!ev) return;

    var recurrent = ev.repeat && ev.repeat !== 'none';
    var dateOcc = App.occCourante ? App.occCourante.date : ev.date;

    var actions = recurrent
      ? [{ id: 'occ',   label: 'Cette date seulement', style: 'btn--soft' },
         { id: 'serie', label: 'Toute la série', style: 'btn--primary' }]
      : [{ id: 'serie', label: 'Supprimer', style: 'btn--primary', ico: 'trash' }];

    UI.confirm({
      titre: 'Supprimer « ' + ev.title + ' » ?',
      texte: recurrent
        ? 'Cet événement se répète. Que veux-tu supprimer ?'
        : 'Cette action est définitive une fois la synchronisation effectuée.',
      actions: actions
    }).then(function (choix) {
      if (!choix) return;
      if (choix === 'occ') Store.skipOccurrence(id, dateOcc);
      else Store.remove(id);
      UI.close('eventModal');
      Cal.render();
      UI.ok('Supprimé');
      planifierSync();
    });
  }

  /* ═════════════════ MODALE JOUR ═════════════════ */
  function ouvrirJour(ymd) {
    App.jourOuvert = ymd;
    Cal.selection = ymd;
    var ajouter = document.querySelector('[data-action="new-event-here"]');
    if (ajouter) ajouter.hidden = !Api.peutEcrire();
    document.querySelector('[data-day-title]').textContent = D.longDate(ymd);

    var liste = Store.onDay(ymd, Cal.filtres);
    var corps = document.querySelector('[data-day-body]');

    if (!liste.length) {
      corps.innerHTML = '<div class="daylist__empty">Aucun événement ce jour-là.</div>';
    } else {
      var h = '<div class="daylist">';
      for (var i = 0; i < liste.length; i++) h += Cal.carte(liste[i]);
      corps.innerHTML = h + '</div>';
    }
    Icons.render(corps);
    UI.open('dayModal');
  }

  /* ═════════════════ RECHERCHE ═════════════════ */
  function chercher(q) {
    var boite = document.querySelector('[data-search-results]');
    var res = Store.search(q);

    if (!q || q.trim().length < 2) { boite.hidden = true; return; }

    if (!res.length) {
      boite.innerHTML = '<div class="sres__empty">Aucun résultat pour « ' + UI.esc(q) + ' »</div>';
    } else {
      var h = '';
      for (var i = 0; i < res.length; i++) {
        var e = res[i], c = Store.cat(e.cat);
        h += '<div class="sres" data-ev="' + e.id + '" data-occ="' + e.date + '" data-goto="' + e.date + '">' +
               '<span class="sres__dot" style="background:' + c.color + '"></span>' +
               '<span class="sres__txt">' +
                 '<span class="sres__title">' + UI.highlight(e.title, q.trim()) + '</span>' +
                 '<span class="sres__meta">' + D.relative(e.date) + ' · ' + c.label +
                   (e.location ? ' · ' + UI.esc(e.location) : '') + '</span>' +
               '</span></div>';
      }
      boite.innerHTML = h;
    }
    boite.hidden = false;

    boite.onclick = function (e) {
      var r = e.target.closest('[data-goto]');
      if (!r) return;
      fermerRecherche();
      Cal.aller(r.dataset.goto);
      ouvrirEvenement(r.dataset.ev, r.dataset.occ);
    };
  }

  function fermerRecherche() {
    var b = document.querySelector('[data-search-results]');
    if (b) b.hidden = true;
  }

  /* ═════════════════ SYNCHRONISATION ═════════════════ */
  function planifierSync() {
    if (!Api.authed()) return;
    clearTimeout(App.minuteurSync);
    App.minuteurSync = setTimeout(function () { synchroniser(true); }, 2500);
  }

  function synchroniser(silencieux) {
    if (!Api.authed()) {
      if (!silencieux) {
        UI.info(Api.configured()
          ? 'Connecte-toi pour synchroniser avec ton serveur.'
          : "Aucun serveur configuré — ouvre « Compte & sauvegarde » pour indiquer l'adresse de ton VPS.");
        ouvrirCompte();
      }
      return Promise.resolve();
    }
    if (!navigator.onLine) {
      if (!silencieux) UI.err('Pas de connexion réseau.');
      majPastilleSync('error');
      return Promise.resolve();
    }

    majPastilleSync('syncing');
    return Api.sync().then(function (r) {
      majEtatSync();
      if (!silencieux) {
        UI.ok('Synchronisé — ' + r.envoyes + ' envoyé' + (r.envoyes > 1 ? 's' : '') +
              ', ' + r.recus + ' reçu' + (r.recus > 1 ? 's' : ''));
      }
      if (r.recus) Cal.render();
    }).catch(function (e) {
      majPastilleSync('error');
      if (e.code === 'UNAUTH') { UI.err('Session expirée, reconnecte-toi.'); return deconnexion(true); }
      if (!silencieux) UI.err(e.message);
      else console.warn('Synchro impossible :', e.message);
    });
  }

  function majPastilleSync(etat) {
    var d = document.querySelector('[data-sync-dot]');
    if (!d) return;
    d.className = 'avatar__dot' + (etat ? ' is-' + etat : '');
  }

  function majEtatSync() {
    var lbl = document.querySelector('[data-sync-label]');
    if (Api.authed()) {
      majPastilleSync(navigator.onLine ? 'online' : 'error');
      if (lbl) {
        lbl.textContent = Store.lastSync
          ? 'Sauvegardé ' + horaire(Store.lastSync)
          : 'Jamais synchronisé';
      }
    } else {
      majPastilleSync(null);
      if (lbl) lbl.textContent = Api.configured() ? 'Hors ligne — non connecté' : 'Mode local (ce navigateur)';
    }
  }

  function horaire(ts) {
    var d = new Date(ts), ecart = (Date.now() - ts) / 1000;
    if (ecart < 60) return "à l'instant";
    if (ecart < 3600) return 'il y a ' + Math.floor(ecart / 60) + ' min';
    if (D.ymd(d) === D.today()) return 'à ' + D.hhmm(d.getHours() * 60 + d.getMinutes());
    return 'le ' + D.shortDate(D.ymd(d));
  }

  /* ═════════════════ COMPTE & SERVEUR ═════════════════ */
  function ouvrirCompte() {
    var box = document.querySelector('[data-acct]');
    if (Api.authed()) {
      box.innerHTML =
        '<div class="acct__av">' + UI.esc(UI.initiales(Api.user.pseudo)) + '</div>' +
        '<div style="min-width:0"><div class="acct__n">' + UI.esc(Api.user.pseudo) + '</div>' +
        '<div class="acct__e">Synchronisé sur ton serveur</div></div>' +
        '<span class="acct__badge acct__badge--on">Connecté</span>';
    } else {
      box.innerHTML =
        '<div class="acct__av">·</div>' +
        '<div style="min-width:0"><div class="acct__n">Mode local</div>' +
        '<div class="acct__e">Données stockées dans ce navigateur uniquement</div></div>' +
        '<span class="acct__badge acct__badge--off">Hors compte</span>';
    }

    // En mode local il n'y a rien à déconnecter : on propose l'inverse,
    // revenir à l'écran de connexion — sans toucher aux données locales.
    document.querySelector('[data-action="logout"]').hidden = !Api.authed();
    document.querySelector('[data-action="signin"]').hidden = Api.authed();

    var note = document.querySelector('[data-storage-note]');
    if (note) {
      note.textContent = Store.count() + ' événement' + (Store.count() > 1 ? 's' : '') +
        ' · ' + Store.sizeKb() + ' Ko utilisés' +
        (Store.lastSync ? ' · dernière sauvegarde ' + horaire(Store.lastSync) : '');
    }

    var boiteInvite = document.querySelector('[data-invite]');
    if (boiteInvite) boiteInvite.hidden = true;

    UI.open('accountModal');
    majPartage();          // après l'ouverture : majPartage n'agit que si visible
    Icons.render(document.getElementById('accountModal'));
  }

  /* ═════════════════ PRÉSENCE ═════════════════ */

  /**
   * Battement de cœur : signale qu'on est actif sur le calendrier affiché.
   * Ne bat que si l'onglet est visible — un onglet en arrière-plan ne doit
   * pas faire croire qu'on est là. La présence expire d'elle-même après
   * deux minutes côté serveur.
   */
  function demarrerPresence() {
    arreterPresence();
    if (!Api.authed()) return;
    battre();
    App.minuteurPresence = setInterval(battre, 60000);
  }

  function arreterPresence() {
    if (App.minuteurPresence) clearInterval(App.minuteurPresence);
    App.minuteurPresence = null;
  }

  function battre() {
    if (!Api.authed() || document.hidden || !navigator.onLine) return;
    Api.presence().then(function (d) {
      App.presents = (d && d.presents) || [];
      majPresenceBouton();
    }).catch(function () { /* sans conséquence */ });
  }

  /** Pastille sur le bouton des calendriers quand quelqu'un d'autre est là */
  function majPresenceBouton() {
    var btn = document.querySelector('[data-action="cal-menu"]');
    if (!btn) return;
    var n = (App.presents || []).length;
    var pastille = btn.querySelector('.calmenu__presence');

    if (n && !pastille) {
      pastille = document.createElement('i');
      pastille.className = 'calmenu__presence';
      btn.appendChild(pastille);
    } else if (!n && pastille) {
      pastille.remove();
    }
    if (pastille) {
      pastille.title = n === 1
        ? (App.presents[0].pseudo + ' est sur ce calendrier')
        : n + ' personnes sont sur ce calendrier';
    }
  }

  /* ═════════════════ PARTAGE ═════════════════ */

  /** Affiche l'état du partage dans la fenêtre « Compte & sauvegarde » */
  function majPartage() {
    var etat = document.querySelector('[data-partage-etat]');
    var actions = document.querySelector('[data-partage-actions]');
    var membres = document.querySelector('[data-membres]');
    var invite = document.querySelector('[data-invite]');
    if (!etat || !actions || !membres) return;
    // Inutile d'interroger le serveur si la fenêtre n'est pas affichée
    if (!UI.isOpen('accountModal')) return;

    if (!Api.authed()) {
      etat.textContent = 'Connecte-toi pour partager ton calendrier.';
      etat.hidden = false;
      actions.hidden = true;
      membres.innerHTML = '';
      if (invite) invite.hidden = true;
      return;
    }

    etat.hidden = true;
    actions.hidden = false;
    membres.innerHTML = '<li class="membres__vide">Chargement…</li>';

    Api.partage().then(function (d) {
      var h = '';

      // Personnes ayant accès à MON calendrier
      (d.membres || []).forEach(function (m) {
        h += '<li>' +
               '<span class="membres__av">' + UI.esc(UI.initiales(m.pseudo)) +
                 '<i class="membres__dot' + (m.enLigne ? ' is-online' : '') + '"></i></span>' +
               '<span><span class="membres__n">' + UI.esc(m.pseudo) + '</span>' +
               '<span class="membres__r">' + presenceTexte(m) + ' · ' +
                 (m.role === 'lecture' ? 'lecture seule' : 'peut modifier') + '</span></span>' +
               '<button class="membres__x" data-action="retirer" data-cal="' + UI.esc(Api.user.id) + '" ' +
                 'data-membre="' + UI.esc(m.id) + '" data-nom="' + UI.esc(m.pseudo) + '" ' +
                 'title="Retirer l’accès"><i data-ico="x"></i></button>' +
             '</li>';
      });

      // Invitations en attente
      (d.invitations || []).forEach(function (inv) {
        var jours = Math.max(0, Math.round((inv.expires_at - Date.now()) / 86400000));
        h += '<li>' +
               '<span class="membres__av">?</span>' +
               '<span><span class="membres__n">' + UI.esc(inv.code) + '</span>' +
               '<span class="membres__r">en attente · expire dans ' + jours + ' j</span></span>' +
               '<button class="membres__x" data-action="annuler-invit" data-code="' + UI.esc(inv.code) + '" ' +
                 'title="Annuler l’invitation"><i data-ico="x"></i></button>' +
             '</li>';
      });

      // Calendriers auxquels J'AI accès
      (d.calendriers || []).forEach(function (c) {
        if (c.role === 'proprietaire') return;
        h += '<li>' +
               '<span class="membres__av">' + UI.esc(UI.initiales(c.pseudo)) +
                 '<i class="membres__dot' + (c.enLigne ? ' is-online' : '') + '"></i></span>' +
               '<span><span class="membres__n">Calendrier de ' + UI.esc(c.pseudo) + '</span>' +
               '<span class="membres__r">' + presenceTexte(c) + ' · ' +
                 (c.role === 'lecture' ? 'lecture seule' : 'tu peux modifier') + '</span></span>' +
               '<button class="membres__x" data-action="retirer" data-cal="' + UI.esc(c.id) + '" ' +
                 'data-membre="' + UI.esc(Api.user.id) + '" data-nom="' + UI.esc(c.pseudo) + '" ' +
                 'title="Quitter ce calendrier"><i data-ico="out"></i></button>' +
             '</li>';
      });

      membres.innerHTML = h || '<li class="membres__vide">Personne ne partage ton calendrier pour l’instant.</li>';
      Icons.render(membres);
      majCalendriers();

      // Rafraîchissement tant que la fenêtre reste ouverte ; la garde en
      // tête de majPartage interrompt la chaîne dès qu'elle se ferme.
      clearTimeout(App.minuteurMembres);
      App.minuteurMembres = setTimeout(majPartage, 20000);
    }).catch(function (e) {
      membres.innerHTML = '<li class="membres__vide">' + UI.esc(e.message) + '</li>';
    });
  }

  /** « en ligne », « il y a 12 min », ou « jamais connecté » */
  function presenceTexte(p) {
    if (p.enLigne) return '<b class="membres__en-ligne">en ligne</b>';
    if (!p.vuLe) return 'hors ligne';
    var min = Math.round((Date.now() - p.vuLe) / 60000);
    if (min < 60) return 'vu il y a ' + min + ' min';
    var heures = Math.round(min / 60);
    if (heures < 24) return 'vu il y a ' + heures + ' h';
    return 'vu il y a ' + Math.round(heures / 24) + ' j';
  }

  function creerInvitation() {
    if (!Api.authed()) return UI.err('Connecte-toi d’abord.');

    UI.confirm({
      titre: 'Inviter quelqu’un',
      texte: 'Quel droit veux-tu accorder sur ton calendrier ?',
      actions: [
        { id: 'ecriture', label: 'Peut modifier', style: 'btn--primary' },
        { id: 'lecture', label: 'Lecture seule', style: 'btn--soft' }
      ]
    }).then(function (role) {
      if (!role) return;
      return Api.inviter(role).then(function (d) {
        // Le code s'affiche dans la fenêtre du compte : on l'ouvre si
        // l'invitation a été lancée depuis le menu de la barre du haut.
        if (!UI.isOpen('accountModal')) ouvrirCompte();

        var boite = document.querySelector('[data-invite]');
        var code = document.querySelector('[data-invite-code]');
        var hint = document.querySelector('[data-invite-hint]');
        if (code) code.textContent = d.code;
        if (hint) {
          hint.textContent = 'Droit : ' + (d.role === 'lecture' ? 'lecture seule' : 'modification') +
            '. Valable 7 jours, utilisable une seule fois. La personne doit avoir un compte, ' +
            'puis saisir ce code via « Rejoindre avec un code ».';
        }
        if (boite) boite.hidden = false;
        App.codeInvite = d.code;
        UI.ok('Code d’invitation créé');
        majPartage();
      });
    }).catch(function (e) { UI.err(e.message); });
  }

  function copierCode() {
    var code = App.codeInvite || (document.querySelector('[data-invite-code]') || {}).textContent;
    if (!code || code === '—') return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(
        function () { UI.ok('Code copié'); },
        function () { UI.info('Copie impossible — sélectionne le code à la main.'); }
      );
    } else {
      UI.info('Sélectionne le code pour le copier.');
    }
  }

  function rejoindreCalendrier() {
    if (!Api.authed()) return UI.err('Connecte-toi d’abord.');

    UI.prompt({
      titre: 'Rejoindre un calendrier',
      texte: 'Saisis le code d’invitation qu’on t’a transmis.',
      placeholder: 'XXXX-XXXX',
      valider: 'Rejoindre'
    }).then(function (code) {
      if (!code) return;
      return Api.rejoindre(code.trim().toUpperCase()).then(function (d) {
        UI.ok('Tu as rejoint le calendrier de ' + d.calendrier.pseudo);
        majPartage();
        majCalendriers();
        changerCalendrier(d.calendrier.id);
      });
    }).catch(function (e) { UI.err(e.message); });
  }

  function retirerAcces(calendrierId, membreId, nom) {
    var moiMeme = membreId === (Api.user && Api.user.id);
    UI.confirm({
      titre: moiMeme ? 'Quitter ce calendrier ?' : 'Retirer l’accès de ' + nom + ' ?',
      texte: moiMeme
        ? 'Tu n’auras plus accès au calendrier de ' + nom + '. Son propriétaire pourra t’inviter à nouveau.'
        : nom + ' ne pourra plus voir ni modifier ton calendrier.',
      actions: [{ id: 'ok', label: moiMeme ? 'Quitter' : 'Retirer', style: 'btn--primary' }]
    }).then(function (r) {
      if (r !== 'ok') return;
      return Api.retirer(calendrierId, membreId).then(function () {
        UI.ok(moiMeme ? 'Calendrier quitté' : 'Accès retiré');
        // Si on quittait le calendrier affiché, on revient au sien
        if (Api.calendrier === calendrierId && moiMeme) changerCalendrier(Api.user.id);
        majPartage();
        majCalendriers();
      });
    }).catch(function (e) { UI.err(e.message); });
  }

  function annulerInvitation(code) {
    Api.annulerInvitation(code).then(function () {
      UI.ok('Invitation annulée');
      var boite = document.querySelector('[data-invite]');
      if (boite && App.codeInvite === code) { boite.hidden = true; App.codeInvite = null; }
      majPartage();
    }).catch(function (e) { UI.err(e.message); });
  }

  /**
   * Quitte le mode local pour revenir à l'écran de connexion.
   * Les événements locaux sont CONSERVÉS : à la première connexion,
   * l'application proposera de les rattacher au compte.
   */
  function retourConnexion() {
    UI.close('accountModal');
    try { localStorage.removeItem(K_MODE); } catch (e) {}
    ouvrirAuth();
    if (Store.count()) {
      UI.info('Tes ' + Store.count() + ' événement(s) restent enregistrés sur cet appareil.');
    }
  }

  function deconnexion(force) {
    var fin = function () {
      try { localStorage.removeItem(K_MODE); } catch (e) {}
      arreterPresence();
      clearTimeout(App.minuteurMembres);
      App.presents = [];
      Api.clearSession();
      UI.close('accountModal');
      ouvrirAuth();
    };
    if (force) return fin();

    UI.confirm({
      titre: 'Se déconnecter ?',
      texte: 'Tes événements restent sauvegardés sur le serveur. Ils seront retirés de ce navigateur.',
      actions: [{ id: 'ok', label: 'Se déconnecter', style: 'btn--primary', ico: 'out' }]
    }).then(function (r) {
      if (r !== 'ok') return;
      synchroniser(true).then(function () {
        Store.clearAll();      // y compris les calendriers partagés en cache
        Api.logout().then(fin, fin);
      });
    });
  }

  /* ═════════════════ EXPORTS ═════════════════ */
  function exporterJson() {
    var data = Store.exportData();
    UI.download('calendrier-' + D.today() + '.json', JSON.stringify(data, null, 2), 'application/json');
    UI.ok(data.events.length + ' événements exportés');
  }

  function exporterIcs() {
    var evs = Store.all();
    var L = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calendrier//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'
    ];

    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      L.push('BEGIN:VEVENT');
      L.push('UID:' + e.id + '@calendrier');
      L.push('DTSTAMP:' + isoUtc(new Date()));

      if (e.allDay) {
        L.push('DTSTART;VALUE=DATE:' + e.date.replace(/-/g, ''));
        var lendemain = D.addDays(e.endDate || e.date, 1);       // DTEND exclusif en iCalendar
        L.push('DTEND;VALUE=DATE:' + lendemain.replace(/-/g, ''));
      } else {
        L.push('DTSTART:' + local(e.date, e.startTime || '09:00'));
        L.push('DTEND:' + local(e.endDate || e.date, e.endTime || D.hhmm(D.mins(e.startTime || '09:00') + 60)));
      }

      if (e.repeat && e.repeat !== 'none') {
        L.push('RRULE:FREQ=' + { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' }[e.repeat]);
      }
      L.push('SUMMARY:' + ics(e.title));
      if (e.notes) L.push('DESCRIPTION:' + ics(e.notes));
      if (e.location) L.push('LOCATION:' + ics(e.location));
      L.push('CATEGORIES:' + ics(Store.cat(e.cat).label));
      if (e.important) L.push('PRIORITY:1');
      if (e.done) L.push('STATUS:CONFIRMED');
      L.push('END:VEVENT');
    }
    L.push('END:VCALENDAR');

    UI.download('calendrier-' + D.today() + '.ics', L.join('\r\n'), 'text/calendar');
    UI.ok('Fichier .ics prêt — importable dans Google Agenda ou Outlook');
  }

  function local(ymd, hm) { return ymd.replace(/-/g, '') + 'T' + (hm || '09:00').replace(':', '') + '00'; }
  function isoUtc(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
  function ics(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  /* ═════════════════ CLAVIER ═════════════════ */
  function brancherClavier() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (UI.cancelConfirm()) return;
        if (UI.anyOpen()) return UI.closeTop();
        fermerRecherche();
        fermerMenuCalendriers();
        return;
      }

      var champ = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

      // Ctrl/Cmd + S : sauvegarde manuelle
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        return synchroniser(false);
      }
      // Ctrl/Cmd + Entrée : valide la modale ouverte
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && UI.isOpen('eventModal')) {
        e.preventDefault();
        return enregistrerEvenement(document.getElementById('eventForm'));
      }
      if (champ || UI.anyOpen()) return;

      switch (e.key) {
        case 'ArrowLeft':  e.preventDefault(); return Cal.pas(-1);
        case 'ArrowRight': e.preventDefault(); return Cal.pas(1);
        case 't': case 'T': return Cal.aller(D.today());
        case 'n': case 'N': e.preventDefault(); return ouvrirEvenement(null, Cal.selection);
        case 'm': case 'M': return Cal.setVue('month');
        case 'w': case 'W': case 's': case 'S': return Cal.setVue('week');
        case 'd': case 'D': case 'j': case 'J': return Cal.setVue('day');
        case 'a': case 'A': return Cal.setVue('agenda');
        case '/': e.preventDefault(); return document.getElementById('searchInput').focus();
      }
    });
  }

  /* ═════════════════ GLOBAL ═════════════════ */
  function brancherGlobal() {
    global.addEventListener('error', function (e) {
      console.error('Erreur :', e.message, e.filename, e.lineno);
      panne('Erreur JavaScript', e.message + '\n' + (e.filename || '') + ' ligne ' + (e.lineno || '?'));
    });
    global.addEventListener('unhandledrejection', function (e) {
      console.error('Promesse rejetée :', e.reason);
    });
  }

  /**
   * Affiche une panne à l'écran plutôt que de laisser l'application
   * inerte et silencieuse — cas le plus déroutant pour l'utilisateur.
   */
  function panne(titre, detail) {
    if (document.getElementById('panneBox')) return;   // une seule fois
    var box = document.createElement('div');
    box.id = 'panneBox';
    box.setAttribute('style',
      'position:fixed;left:0;right:0;top:0;z-index:9999;padding:14px 18px;' +
      'background:#7f1d1d;color:#fff;font:14px/1.5 system-ui,sans-serif;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.4)');
    box.innerHTML =
      '<b>' + UI.esc(titre) + '</b><br>' +
      '<span style="font-size:12.5px;opacity:.9;white-space:pre-wrap">' + UI.esc(detail) + '</span>' +
      '<br><span style="font-size:12px;opacity:.75">Ouvre la console (F12) pour le détail complet.</span>';
    (document.body || document.documentElement).appendChild(box);
  }

  /** Vérifie que les six scripts se sont bien chargés, dans l'ordre */
  function modulesManquants() {
    var requis = [
      ['Icons', 'assets/js/icons.js'],
      ['Store', 'assets/js/store.js'],
      ['Dates', 'assets/js/store.js'],
      ['Api',   'assets/js/api.js'],
      ['UI',    'assets/js/ui.js'],
      ['Cal',   'assets/js/calendar.js']
    ];
    var absents = [];
    for (var i = 0; i < requis.length; i++) {
      if (!global[requis[i][0]]) absents.push(requis[i][1]);
    }
    return absents;
  }

  /* ─────────── Go ─────────── */
  function lancer() {
    var absents = modulesManquants();
    if (absents.length) {
      // UI n'est peut-être pas chargé : message minimal, sans dépendance
      var msg = 'Fichier(s) non chargé(s) : ' + absents.join(', ');
      console.error(msg);
      var b = document.createElement('div');
      b.setAttribute('style', 'position:fixed;inset:0;z-index:9999;padding:40px;' +
        'background:#7f1d1d;color:#fff;font:15px/1.6 system-ui,sans-serif');
      b.textContent = 'Calendrier : ' + msg +
        '. Vérifie que le dossier « assets » est bien présent à côté de index.html.';
      (document.body || document.documentElement).appendChild(b);
      return;
    }
    try {
      demarrer();
    } catch (e) {
      console.error(e);
      panne('Le démarrage a échoué', (e && e.message) || String(e));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', lancer);
  } else {
    lancer();
  }

  global.App = App;
})(window);
