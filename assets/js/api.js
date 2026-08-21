/* ═══════════════════════════════════════════════════════════
   api.js — dialogue avec l'API hébergée sur le VPS
   Le site reste utilisable sans serveur : tout ce qui suit
   est optionnel et ne bloque jamais l'application.
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────
     Adresse de l'API utilisée quand l'utilisateur n'en a saisi
     aucune. Modifie cette ligne si tu changes de serveur.
     Laisse la chaîne vide pour exiger une saisie manuelle.
     ───────────────────────────────────────────────────────── */
  var SERVEUR_DEFAUT = 'https://api-c.code-eternal.fr';

  var K_BASE  = 'calendrier:server';
  var K_TOKEN = 'calendrier:token';
  var K_USER  = 'calendrier:user';

  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) { localStorage.removeItem(k); return null; }
      localStorage.setItem(k, v); return v;
    } catch (e) { return null; }
  }

  var Api = {
    base: '',
    token: '',
    user: null,

    /* ── Configuration ── */
    load: function () {
      // Une adresse enregistrée par l'utilisateur prime toujours
      // sur celle inscrite dans le code.
      Api.base = ls(K_BASE) || SERVEUR_DEFAUT;
      Api.token = ls(K_TOKEN) || '';
      try { Api.user = JSON.parse(ls(K_USER) || 'null'); } catch (e) { Api.user = null; }
      return Api;
    },

    setBase: function (url) {
      url = (url || '').trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      Api.base = url;
      ls(K_BASE, url || null);
      return url;
    },

    setSession: function (token, user) {
      Api.token = token || '';
      Api.user = user || null;
      ls(K_TOKEN, token || null);
      ls(K_USER, user ? JSON.stringify(user) : null);
    },

    clearSession: function () { Api.setSession(null, null); },

    configured: function () { return !!Api.base; },
    authed: function () { return !!(Api.base && Api.token && Api.user); },

    /** Vérifie qu'un appel https -> http n'est pas condamné d'avance */
    mixedContent: function () {
      return location.protocol === 'https:' && /^http:\/\//i.test(Api.base);
    },

    /* ── Requête bas niveau ── */
    request: function (path, opts) {
      opts = opts || {};
      if (!Api.base) return Promise.reject(err('NO_SERVER', 'Aucun serveur configuré.'));
      if (Api.mixedContent()) {
        return Promise.reject(err('MIXED', "L'API doit être en https:// — le navigateur bloque les appels non sécurisés depuis une page https."));
      }

      var headers = { 'Accept': 'application/json' };
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      if (opts.auth !== false && Api.token) headers['Authorization'] = 'Bearer ' + Api.token;

      var ctrl = global.AbortController ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || 15000) : null;

      return fetch(Api.base + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl ? ctrl.signal : undefined,
        mode: 'cors',
        cache: 'no-store'
      }).then(function (res) {
        if (timer) clearTimeout(timer);
        return res.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) { /* réponse non JSON */ }

          if (!res.ok) {
            if (res.status === 401) {
              Api.clearSession();
              throw err('UNAUTH', (data && data.error) || 'Session expirée, reconnecte-toi.');
            }
            throw err('HTTP_' + res.status, (data && data.error) || messageHttp(res.status));
          }
          return data;
        });
      }).catch(function (e) {
        if (timer) clearTimeout(timer);
        if (e && e.code) throw e;
        if (e && e.name === 'AbortError') throw err('TIMEOUT', 'Le serveur met trop de temps à répondre.');
        // `fetch` ne dit jamais POURQUOI il a échoué : on va le déterminer.
        return diagnostiquer().then(function (message) { throw err('NETWORK', message); });
      });
    },

    /** Message de diagnostic, sans lancer de requête (pour l'affichage) */
    origine: function () {
      var o = global.location && global.location.origin;
      return (o && o !== 'null') ? o : null;
    },

    /* ── Points d'entrée ── */
    ping: function () {
      return Api.request('/api/health', { auth: false, timeout: 8000 });
    },

    register: function (pseudo, password) {
      return Api.request('/api/auth/register', {
        method: 'POST', auth: false,
        body: { pseudo: pseudo, password: password }
      }).then(session);
    },

    login: function (pseudo, password) {
      return Api.request('/api/auth/login', {
        method: 'POST', auth: false,
        body: { pseudo: pseudo, password: password }
      }).then(session);
    },

    me: function () {
      return Api.request('/api/me').then(function (d) {
        if (d && d.user) { Api.user = d.user; ls(K_USER, JSON.stringify(d.user)); }
        return d && d.user;
      });
    },

    logout: function () {
      var p = Api.token ? Api.request('/api/auth/logout', { method: 'POST' }).catch(function () {}) : Promise.resolve();
      return p.then(function () { Api.clearSession(); });
    },

    /**
     * Synchronisation bidirectionnelle.
     *  - envoie les modifications locales depuis Store.lastSync (horloge client)
     *  - reçoit celles du serveur depuis Store.cursor (horloge serveur)
     * Résolution des conflits : la modification la plus récente gagne.
     */
    sync: function () {
      if (!Api.authed()) return Promise.reject(err('NO_AUTH', 'Connecte-toi pour synchroniser.'));

      var depuis = Store.lastSync || 0;
      var sortants = Store.changesSince(depuis);
      var debut = Date.now();
      var recus = 0, total = 0;

      // Le serveur tronque les grosses réponses et signale `more` :
      // on redemande la suite jusqu'à épuisement (10 tours maximum).
      function tour(aEnvoyer, reste) {
        return Api.request('/api/sync', {
          method: 'POST',
          timeout: 25000,
          body: { cursor: Store.cursor || 0, events: aEnvoyer }
        }).then(function (d) {
          d = d || {};
          recus += Store.applyRemote(d.events || []);
          Store.cursor = d.cursor || Store.cursor || 0;
          total = d.total;
          Store.save();
          if (d.more && reste > 0) return tour([], reste - 1);
        });
      }

      return tour(sortants, 10).then(function () {
        Store.lastSync = debut;
        Store.save();
        return { envoyes: sortants.length, recus: recus, total: total };
      });
    },

    /** Sauvegarde manuelle : pousse tout, sans tenir compte du curseur */
    pushAll: function () {
      if (!Api.authed()) return Promise.reject(err('NO_AUTH', 'Connecte-toi pour sauvegarder.'));
      var tout = [];
      for (var id in Store.events) tout.push(Store.events[id]);
      return Api.request('/api/sync', {
        method: 'POST', timeout: 40000,
        body: { cursor: 0, events: tout, full: true }
      }).then(function (d) {
        d = d || {};
        Store.applyRemote(d.events || []);
        Store.lastSync = Date.now();
        Store.cursor = d.cursor || 0;
        Store.save();
        return { envoyes: tout.length, total: d.total };
      });
    }
  };

  function session(d) {
    if (!d || !d.token) throw err('BAD_RESPONSE', 'Réponse inattendue du serveur.');
    Api.setSession(d.token, d.user);
    return d.user;
  }

  function err(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /**
   * Détermine la vraie cause d'un échec réseau.
   * Une requête « no-cors » aboutit dès que le serveur répond, même
   * lorsque CORS interdit de lire la réponse. Si elle passe, le serveur
   * est joignable et c'est donc CORS qui bloque ; sinon il est vraiment
   * hors d'atteinte.
   */
  function diagnostiquer() {
    var origine = Api.origine();

    // 1) /api/health est lisible par toutes les origines : on peut donc
    //    lire ce que le serveur voit réellement de nous.
    return fetch(Api.base + '/api/health', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.ok !== true) throw new Error('réponse inattendue');

        if (typeof d.origineAutorisee === 'undefined') {
          return 'Le serveur répond, mais il fait tourner une version antérieure de l’API.\n' +
                 'Mets-la à jour sur le VPS :\n' +
                 'cd /root/calendrier && git pull\n' +
                 'bash server/deploy/install.sh <domaine> ' + (origine || '<origine>');
        }
        if (d.origineAutorisee === false) {
          return 'Le serveur voit ce site comme « ' + (d.origineVue || '(aucune origine)') + ' »\n' +
                 'et ne l’autorise pas (' + d.originesConfigurees + ' origine(s) déclarée(s)).\n' +
                 'Sur le VPS, dans /opt/calendrier/server/.env :\n' +
                 'ALLOWED_ORIGINS=' + (d.origineVue || origine) + '\n' +
                 'puis : systemctl restart calendrier-api';
        }
        if (d.origineAutorisee === true) {
          return 'Le serveur autorise bien ce site, mais la requête a tout de même échoué.\n' +
                 'Regarde la console (F12) et /var/log/nginx/calendrier-error.log';
        }
        return 'Le serveur n’a vu aucune origine — page ouverte en fichier local ?\n' +
               'Ouvre le site par son adresse https://.';
      })
      .catch(function () {
        // 2) L'API n'a pas répondu. Quelque chose d'autre répond-il ?
        return fetch(Api.base + '/api/health', { mode: 'no-cors', cache: 'no-store' })
          .then(function () {
            return 'Quelque chose répond à l’adresse ' + Api.base + ', mais ce n’est pas l’API.\n' +
                   'Le plus souvent une erreur 502 de Nginx : proxy_pass sur le mauvais port.\n' +
                   'Sur le VPS : curl -i ' + Api.base + '/api/health';
          })
          .catch(function () {
            return 'Serveur injoignable à l’adresse ' + Api.base + '.\n' +
                   'Vérifie le DNS, le certificat HTTPS, et systemctl status calendrier-api.';
          });
      });
  }

  function messageHttp(s) {
    if (s === 400) return 'Requête invalide.';
    if (s === 403) return 'Accès refusé.';
    if (s === 404) return "Adresse introuvable — l'API n'est peut-être pas déployée à cette URL.";
    if (s === 409) return 'Cette adresse e-mail est déjà utilisée.';
    if (s === 429) return 'Trop de tentatives. Réessaie dans une minute.';
    if (s >= 500) return 'Erreur du serveur. Consulte les journaux du VPS.';
    return 'Erreur ' + s + '.';
  }

  global.Api = Api;
})(window);
