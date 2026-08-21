/* ═══════════════════════════════════════════════════════════
   run.js — lance les trois suites de tests du projet
       node test/run.js
   ═══════════════════════════════════════════════════════════ */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const RACINE = path.join(__dirname, '..');

const suites = [
  ['Modèle de données et dates', 'test/store.test.js'],
  ['Moteur de rendu des vues',   'test/render.test.js'],
  ['Pièges du navigateur',       'test/lint.test.js'],
  ['API du serveur (bout en bout)', 'server/test/e2e.js']
];

let echecs = 0;

for (const [nom, fichier] of suites) {
  console.log(`\n\x1b[1;35m━━━ ${nom} ━━━\x1b[0m`);
  const r = spawnSync(process.execPath, [path.join(RACINE, fichier)], {
    cwd: RACINE, stdio: 'inherit'
  });
  if (r.status !== 0) echecs++;
}

console.log(
  echecs
    ? `\n\x1b[31m✖ ${echecs} suite(s) en échec\x1b[0m`
    : '\n\x1b[32m✔ Toutes les suites passent\x1b[0m'
);
process.exit(echecs ? 1 : 0);
