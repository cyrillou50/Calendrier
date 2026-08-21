/* Jeu d'icônes SVG inline — aucune dépendance externe.
   Usage : <i data-ico="cal"></i>  puis  Icons.render(racine) */
(function (global) {
  'use strict';

  var P = {
    'cal':     '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
    'clock':   '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    'plus':    '<path d="M12 5v14M5 12h14"/>',
    'x':       '<path d="M6 6l12 12M18 6L6 18"/>',
    'check':   '<path d="M4.5 12.5l5 5 10-11"/>',
    'chev-l':  '<path d="M15 5l-7 7 7 7"/>',
    'chev-r':  '<path d="M9 5l7 7-7 7"/>',
    'search':  '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
    'menu':    '<path d="M4 7h16M4 12h16M4 17h16"/>',
    'moon':    '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/>',
    'sun':     '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/>',
    'star':    '<path d="M12 3.2l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.7l6.1-.9z"/>',
    'trash':   '<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    'pin':     '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    'sync':    '<path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9M3.5 12a8.5 8.5 0 0 1 14.6-5.9"/><path d="M18 2.5V7h-4.5M6 21.5V17h4.5"/>',
    'bolt':    '<path d="M13.5 2.5L4 13.8h6.5L10 21.5 20 10.2h-6.6z"/>',
    'mail':    '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M3 7l9 6 9-6"/>',
    'lock':    '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.4a4 4 0 0 1 8 0v3.1"/>',
    'eye':     '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M10.6 6a9.9 9.9 0 0 1 1.4-.1c6 0 9.5 6.1 9.5 6.1a17 17 0 0 1-3 3.7M6.2 7.7A16.6 16.6 0 0 0 2.5 12S6 18.1 12 18.1a9.4 9.4 0 0 0 3.6-.7"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/>',
    'user':    '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    'device':  '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M10.5 17.5h3"/>',
    'server':  '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    'repeat':  '<path d="M4 9V7.5A2.5 2.5 0 0 1 6.5 5H19M20 15v1.5a2.5 2.5 0 0 1-2.5 2.5H5"/><path d="M17 2.5L20 5l-3 2.5M7 16.5L4 19l3 2.5"/>',
    'info':    '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8h.01"/>',
    'down':    '<path d="M12 3.5v13M6.5 11L12 16.5 17.5 11M4 20.5h16"/>',
    'up':      '<path d="M12 20.5v-13M6.5 13L12 7.5 17.5 13M4 3.5h16"/>',
    'out':     '<path d="M9.5 4.5H6A2 2 0 0 0 4 6.5v11a2 2 0 0 0 2 2h3.5"/><path d="M15 8l4 4-4 4M19 12H9"/>',
    'note':    '<path d="M5 3.5h9l5 5v12a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 20.5V5a1.5 1.5 0 0 1 1-1.5z"/><path d="M14 3.5v5h5M8 13h8M8 17h5"/>',
    'inbox':   '<path d="M3.5 13.5h4l1.5 3h6l1.5-3h4"/><path d="M5.2 5h13.6l2.7 8.5v4.5a2 2 0 0 1-2 2H4.5a2 2 0 0 1-2-2v-4.5z"/>',
    'users':   '<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16.5 5.2a3.4 3.4 0 0 1 0 5.6M18 14.4a6.5 6.5 0 0 1 3.5 5.6"/>',
    'copy':    '<rect x="9" y="9" width="11.5" height="11.5" rx="2.5"/><path d="M6 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V6"/>'
  };

  var Icons = {
    svg: function (name) {
      var d = P[name];
      if (!d) return '';
      return '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
    },
    render: function (root) {
      var nodes = (root || document).querySelectorAll('i[data-ico]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.dataset.icoDone === el.dataset.ico) continue;
        el.innerHTML = Icons.svg(el.dataset.ico);
        el.dataset.icoDone = el.dataset.ico;
      }
    }
  };

  global.Icons = Icons;
})(window);
