/* ═══════════════════════════════════════════════════════════
   ui.js — briques d'interface : modales, toasts, confirmations
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var pileModales = [];

  var UI = {

    /** Échappe le HTML — toute donnée utilisateur passe par ici */
    esc: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    /** Met en gras les occurrences de `q` dans `texte` (déjà échappé) */
    highlight: function (texte, q) {
      var t = UI.esc(texte);
      if (!q || q.length < 2) return t;
      var re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
      return t.replace(re, '<mark>$1</mark>');
    },

    /* ─────────── Modales ─────────── */
    open: function (id) {
      var el = document.getElementById(id);
      if (!el || pileModales.indexOf(id) !== -1) return el;
      el.hidden = false;
      pileModales.push(id);
      document.body.style.overflow = 'hidden';
      // focus sur le premier champ utile
      setTimeout(function () {
        var f = el.querySelector('input:not([type=hidden]):not([disabled]), textarea, select, button.btn--primary');
        if (f && !('ontouchstart' in window)) f.focus();
      }, 60);
      return el;
    },

    close: function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var i = pileModales.indexOf(id);
      if (i !== -1) pileModales.splice(i, 1);
      el.hidden = true;
      if (!pileModales.length) document.body.style.overflow = '';
    },

    closeTop: function () {
      if (pileModales.length) UI.close(pileModales[pileModales.length - 1]);
    },

    isOpen: function (id) { return pileModales.indexOf(id) !== -1; },
    anyOpen: function () { return pileModales.length > 0; },

    /* ─────────── Toasts ─────────── */
    toast: function (message, type, duree) {
      var hote = document.querySelector('[data-toasts]');
      if (!hote) return;
      var ico = type === 'err' ? 'info' : type === 'info' ? 'info' : 'check';
      var t = document.createElement('div');
      t.className = 'toast toast--' + (type || 'ok');
      t.innerHTML = '<i data-ico="' + ico + '"></i><span>' + UI.esc(message) + '</span>';
      hote.appendChild(t);
      Icons.render(t);

      var mort = setTimeout(fermer, duree || (type === 'err' ? 5200 : 2800));
      t.addEventListener('click', function () { clearTimeout(mort); fermer(); });

      function fermer() {
        if (!t.parentNode) return;
        t.classList.add('is-out');
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
      }
    },

    ok:   function (m) { UI.toast(m, 'ok'); },
    err:  function (m) { UI.toast(m, 'err'); },
    info: function (m) { UI.toast(m, 'info'); },

    /* ─────────── Confirmation ───────────
       UI.confirm({ titre, texte, actions:[{ id, label, style }] })
       -> Promise résolue avec l'id du bouton cliqué (ou null si annulé) */
    confirm: function (opts) {
      return new Promise(function (resolve) {
        var actions = opts.actions || [{ id: 'ok', label: 'Confirmer', style: 'btn--primary' }];

        var wrap = document.createElement('div');
        wrap.className = 'modal';
        wrap.id = 'confirmModal';

        var boutons = actions.map(function (a) {
          return '<button class="btn ' + (a.style || 'btn--soft') + '" data-id="' + UI.esc(a.id) + '">' +
                 (a.ico ? '<i data-ico="' + a.ico + '"></i>' : '') + UI.esc(a.label) + '</button>';
        }).join('');

        wrap.innerHTML =
          '<div class="modal__backdrop" data-cancel></div>' +
          '<div class="modal__panel modal__panel--sm" role="dialog" aria-modal="true">' +
            '<header class="modal__head"><h2>' + UI.esc(opts.titre || 'Confirmer') + '</h2>' +
              '<button class="icon-btn" data-cancel><i data-ico="x"></i></button></header>' +
            '<div class="modal__body"><p style="color:var(--text-2);font-size:14px;line-height:1.6">' +
              UI.esc(opts.texte || '') + '</p></div>' +
            '<footer class="modal__foot"><div class="modal__foot-right">' +
              '<button class="btn btn--ghost" data-cancel>Annuler</button>' + boutons +
            '</div></footer>' +
          '</div>';

        document.body.appendChild(wrap);
        Icons.render(wrap);
        pileModales.push('confirmModal');
        document.body.style.overflow = 'hidden';

        wrap.addEventListener('click', function (e) {
          var annule = e.target.closest('[data-cancel]');
          var choix = e.target.closest('[data-id]');
          if (annule) return termine(null);
          if (choix) return termine(choix.dataset.id);
        });

        function termine(val) {
          var i = pileModales.indexOf('confirmModal');
          if (i !== -1) pileModales.splice(i, 1);
          if (!pileModales.length) document.body.style.overflow = '';
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          resolve(val);
        }

        wrap._cancel = termine;
      });
    },

    /* ─────────── Saisie ───────────
       UI.prompt({ titre, texte, placeholder, valeur, valider })
       -> Promise résolue avec le texte saisi, ou null si annulé */
    prompt: function (opts) {
      return new Promise(function (resolve) {
        var wrap = document.createElement('div');
        wrap.className = 'modal';
        wrap.id = 'confirmModal';   // même identifiant : géré par Échap

        wrap.innerHTML =
          '<div class="modal__backdrop" data-cancel></div>' +
          '<div class="modal__panel modal__panel--sm" role="dialog" aria-modal="true">' +
            '<header class="modal__head"><h2>' + UI.esc(opts.titre || 'Saisie') + '</h2>' +
              '<button class="icon-btn" data-cancel><i data-ico="x"></i></button></header>' +
            '<div class="modal__body">' +
              (opts.texte ? '<p style="color:var(--text-2);font-size:13.5px;line-height:1.6">' +
                UI.esc(opts.texte) + '</p>' : '') +
              '<label class="field"><span class="field__wrap">' +
                '<input type="text" data-saisie autocomplete="off" autocapitalize="characters" ' +
                'spellcheck="false" placeholder="' + UI.esc(opts.placeholder || '') + '" ' +
                'value="' + UI.esc(opts.valeur || '') + '"></span></label>' +
              '<p class="form__error" data-err hidden></p>' +
            '</div>' +
            '<footer class="modal__foot"><div class="modal__foot-right">' +
              '<button class="btn btn--ghost" data-cancel>Annuler</button>' +
              '<button class="btn btn--primary" data-ok>' + UI.esc(opts.valider || 'Valider') + '</button>' +
            '</div></footer>' +
          '</div>';

        document.body.appendChild(wrap);
        Icons.render(wrap);
        pileModales.push('confirmModal');
        document.body.style.overflow = 'hidden';

        var champ = wrap.querySelector('[data-saisie]');
        setTimeout(function () { champ.focus(); }, 60);

        champ.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); valider(); }
        });

        wrap.addEventListener('click', function (e) {
          if (e.target.closest('[data-cancel]')) return termine(null);
          if (e.target.closest('[data-ok]')) return valider();
        });

        function valider() {
          var v = champ.value.trim();
          if (!v) { champ.focus(); return; }
          termine(v);
        }

        function termine(val) {
          var i = pileModales.indexOf('confirmModal');
          if (i !== -1) pileModales.splice(i, 1);
          if (!pileModales.length) document.body.style.overflow = '';
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          resolve(val);
        }

        wrap._cancel = termine;
      });
    },

    /** Ferme la confirmation ouverte (utilisé par la touche Échap) */
    cancelConfirm: function () {
      var w = document.getElementById('confirmModal');
      if (w && w._cancel) { w._cancel(null); return true; }
      return false;
    },

    /* ─────────── Téléchargement d'un fichier ─────────── */
    download: function (nomFichier, contenu, mime) {
      var blob = new Blob([contenu], { type: (mime || 'application/json') + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = nomFichier;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 400);
    },

    /* ─────────── Divers ─────────── */
    /** Couleur de texte lisible sur un fond donné */
    lisible: function (hex) {
      var c = hex.replace('#', '');
      if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
      var r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
      return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#11162a' : '#ffffff';
    },

    /** Variables CSS d'une pastille colorée : fond translucide + accent */
    styleCouleur: function (hex, plein) {
      if (plein) {
        return '--_c:' + hex + ';--_bg:' + hex + ';--_fg:' + UI.lisible(hex);
      }
      return '--_c:' + hex +
             ';--_bg:color-mix(in srgb,' + hex + ' 17%, transparent)' +
             ';--_fg:var(--text)';
    },

    initiales: function (nom) {
      var p = String(nom || '?').trim().split(/\s+/);
      return ((p[0] ? p[0][0] : '?') + (p[1] ? p[1][0] : '')).toUpperCase();
    }
  };

  global.UI = UI;
})(window);
