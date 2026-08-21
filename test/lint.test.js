/* ═══════════════════════════════════════════════════════════
   lint.test.js — pièges silencieux du navigateur
   Ces erreurs ne se voient ni à la compilation, ni dans les
   tests unitaires : l'application se charge et reste inerte.
   ═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = path.join(__dirname, '..');
const lire = (f) => fs.readFileSync(path.join(R, f), 'utf8');

const html = lire('index.html');
const css = lire('assets/css/style.css');
const MODULES = ['icons', 'store', 'api', 'ui', 'calendar', 'app'];
const js = Object.fromEntries(MODULES.map(m => [m, lire(`assets/js/${m}.js`)]));
const tout = Object.values(js).join('\n');

let ok = 0, ko = 0;
function verifie(nom, coupables) {
  if (!coupables.length) { ok++; console.log('  ok   ' + nom); }
  else {
    ko++;
    console.log('  KO   ' + nom);
    coupables.slice(0, 8).forEach(c => console.log('         ' + c));
  }
}

/* ─────────────────────────────────────────────────────────
   1 · Accès aux champs d'un formulaire
   `form.title` ne renvoie PAS le champ nommé "title" : les
   propriétés natives de HTMLElement gagnent sur l'accès par
   nom. On obtient une chaîne, et `.value = ...` lève une
   TypeError en mode strict. Idem pour id, name, method...
   La forme sûre est `form.elements.title`.
   ───────────────────────────────────────────────────────── */
console.log('\n── Champs de formulaire ──');
{
  // Propriétés réelles de HTMLFormElement / HTMLElement / Element
  const RESERVES = [
    'id', 'title', 'name', 'method', 'action', 'target', 'length', 'style',
    'lang', 'dir', 'hidden', 'slot', 'children', 'classList', 'dataset'
  ];
  const coupables = [];
  for (const [nom, src] of Object.entries(js)) {
    src.split('\n').forEach((ligne, i) => {
      // variables couramment utilisées pour un formulaire dans ce projet
      const re = new RegExp(`\\b(form|f)\\.(${RESERVES.join('|')})\\b(?!\\s*=[^=])`, 'g');
      for (const m of ligne.matchAll(re)) {
        // form.dataset / form.classList sont des usages légitimes
        if (['dataset', 'classList', 'children', 'style'].includes(m[2])) continue;
        coupables.push(`${nom}.js:${i + 1}  ${m[0]}  → utilise ${m[1]}.elements.${m[2]}`);
      }
    });
  }
  verifie('aucun accès direct à un champ réservé', coupables);
}

/* ─────────────────────────────────────────────────────────
   2 · Les modules exposent bien ce que les autres consomment
   ───────────────────────────────────────────────────────── */
console.log('\n── Cohérence entre modules ──');
{
  const mem = {};
  const stub = () => new Proxy(function () {}, { get: () => stub(), apply: () => stub(), set: () => true });
  const win = {
    console: { warn() {}, error() {}, log() {} }, crypto: require('node:crypto'), document: stub(),
    localStorage: { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } },
    setTimeout() {}, setInterval() {}, requestAnimationFrame() {}, addEventListener() {},
    matchMedia: () => ({ matches: false }), navigator: { onLine: true },
    location: { protocol: 'https:' }, fetch: () => Promise.reject(new Error('hors ligne'))
  };
  win.window = win;
  const ctx = vm.createContext(win);
  for (const m of ['icons', 'store', 'api', 'ui', 'calendar']) {
    vm.runInContext(js[m], ctx, { filename: m + '.js' });
  }

  const objets = { Store: ctx.Store, Cal: ctx.Cal, UI: ctx.UI, Api: ctx.Api, Icons: ctx.Icons, D: ctx.Dates };
  const coupables = [];
  for (const [nom, src] of Object.entries(js)) {
    for (const m of src.matchAll(/\b(Store|Cal|UI|Api|Icons|D)\.([\w$]+)/g)) {
      if (!(m[2] in objets[m[1]])) coupables.push(`${nom}.js  ${m[1]}.${m[2]} n'existe pas`);
    }
  }
  verifie('tous les appels inter-modules existent', [...new Set(coupables)]);
}

/* ─────────────────────────────────────────────────────────
   3 · Sélecteurs, icônes et styles réellement présents
   ───────────────────────────────────────────────────────── */
console.log('\n── Sélecteurs et ressources ──');
{
  // identifiants recherchés par getElementById
  const ids = new Set();
  for (const m of tout.matchAll(/getElementById\(['"]([\w-]+)['"]\)/g)) ids.add(m[1]);
  ids.delete('confirmModal');   // créé dynamiquement par UI.confirm
  ids.delete('panneBox');       // créé dynamiquement en cas d'erreur au démarrage
  verifie('tous les id existent dans index.html',
    [...ids].filter(i => !html.includes(`id="${i}"`)));

  // icônes demandées
  const dispo = new Set();
  for (const m of js.icons.matchAll(/^\s*'([\w-]+)':\s*'/gm)) dispo.add(m[1]);
  const demandees = new Set();
  for (const m of (tout + html).matchAll(/data-ico="([\w-]+)"/g)) demandees.add(m[1]);
  verifie('toutes les icônes existent', [...demandees].filter(i => !dispo.has(i)));

  // actions déclarées dans le HTML et traitées par app.js
  const actions = new Set();
  for (const m of html.matchAll(/data-action="([\w-]+)"/g)) actions.add(m[1]);
  const traitees = new Set();
  for (const m of js.app.matchAll(/case '([\w-]+)':/g)) traitees.add(m[1]);
  // toutes les actions passent par le switch de executer()
  verifie('toutes les actions du HTML sont traitées',
    [...actions].filter(a => !traitees.has(a)));

  // Les modales vivent HORS de #app : si la délégation des actions est
  // posée sur #app, leurs boutons ne répondent jamais. Elle doit être
  // au niveau du document.
  const delegationGlobale = /document\.addEventListener\('click',[\s\S]{0,220}\[data-action\]/.test(js.app);
  verifie('les actions sont déléguées au document, pas à #app',
    delegationGlobale ? [] : ['la délégation [data-action] doit être posée sur document : ' +
      'les modales sont hors de #app et ne recevraient jamais le clic']);

  // Chaque action utilisée dans une modale doit exister
  const dansModales = new Set();
  for (const bloc of html.matchAll(/<div class="modal"[\s\S]*?<\/div>\s*<\/div>/g)) {
    for (const m of bloc[0].matchAll(/data-action="([\w-]+)"/g)) dansModales.add(m[1]);
  }
  verifie('les actions des modales sont traitées',
    [...dansModales].filter(a => !traitees.has(a)));

  // variables CSS
  const vars = new Set();
  for (const m of (css + tout).matchAll(/var\((--[\w-]+)/g)) vars.add(m[1]);
  ['--_c', '--_bg', '--_fg'].forEach(v => vars.delete(v));   // posées en style inline
  verifie('toutes les variables CSS sont définies',
    [...vars].filter(v => !css.includes(v + ':')));

  // scripts référencés par index.html
  verifie('tous les scripts de index.html existent',
    [...html.matchAll(/<script src="([^"]+)"/g)]
      .map(m => m[1])
      .filter(p => !fs.existsSync(path.join(R, p))));
}

console.log('\n' + (ko ? `${ko} ÉCHEC(S) sur ${ok + ko}` : `Tous les tests passent (${ok})`));
process.exit(ko ? 1 : 0);
