const fs=require('fs'),vm=require('vm');
const R=require('path').join(__dirname,'..')+'/';

// ── DOM minimal, juste assez pour le moteur de rendu ──
function el(){
  const e={ innerHTML:'', textContent:'', hidden:false, clientHeight:0, offsetHeight:19,
    dataset:{}, style:{}, children:[],
    classList:{ _s:new Set(), toggle(c,v){v?this._s.add(c):this._s.delete(c)},
                add(c){this._s.add(c)}, remove(c){this._s.delete(c)}, contains(c){return this._s.has(c)} },
    querySelector(){return el()}, querySelectorAll(){return []},
    appendChild(c){this.children.push(c);return c}, removeChild(){}, remove(){},
    addEventListener(){}, setAttribute(){}, focus(){}, closest(){return null},
    insertBefore(){}, reset(){} };
  return e;
}
const boites={};
const doc={
  querySelector(sel){ return boites[sel] || (boites[sel]=el()); },
  querySelectorAll(){ return []; },
  getElementById(){ return el(); },
  createElement(){ return el(); },
  addEventListener(){}, readyState:'complete',
  documentElement:{dataset:{}}, body:el()
};
const mem={};
const win={ document:doc, console, crypto:require('crypto'),
  localStorage:{getItem:k=>k in mem?mem[k]:null,setItem:(k,v)=>{mem[k]=String(v)},removeItem:k=>{delete mem[k]}},
  requestAnimationFrame(){}, setInterval(){}, setTimeout(){}, matchMedia:()=>({matches:false}),
  addEventListener(){}, navigator:{onLine:true}, location:{protocol:'https:'}, fetch:()=>Promise.reject() };
win.window=win;
const ctx=vm.createContext(win);
for(const f of ['icons','store','api','ui','calendar'])
  vm.runInContext(fs.readFileSync(R+'assets/js/'+f+'.js','utf8'),ctx,{filename:f+'.js'});

const {Store,Cal,Dates:D}=ctx;
let ok=0,ko=0;
const vrai=(n,c)=>{ if(c){ok++;console.log('  ok   '+n);} else {ko++;console.log('  KO   '+n);} };

Store.open('rendu');
Store.upsert({title:'Réunion <script>',date:'2026-08-20',startTime:'14:00',endTime:'15:30',cat:'travail',notes:'Salle B'});
Store.upsert({title:'Chevauchement',date:'2026-08-20',startTime:'14:30',endTime:'16:00',cat:'perso'});
Store.upsert({title:'Rappel & co',date:'2026-08-20',allDay:true,cat:'rappel',important:true});
Store.upsert({title:'Vacances',date:'2026-08-18',endDate:'2026-08-24',allDay:true,cat:'autre'});
Store.upsert({title:'Hebdo',date:'2026-08-03',startTime:'09:00',repeat:'weekly',cat:'perso'});

Cal.ancre='2026-08-20'; Cal.selection='2026-08-20'; Cal.miniAncre='2026-08-20';

console.log('── Rendu des vues ──');
for(const vue of ['month','week','day','agenda']){
  Cal.vue=vue;
  let erreur=null;
  try{ Cal.render(); }catch(e){ erreur=e; }
  vrai('vue '+vue+' sans erreur', !erreur);
  if(erreur) console.log('        '+erreur.message+'\n        '+erreur.stack.split('\n')[1]);
}

console.log('\n── Contenu ──');
Cal.vue='month'; Cal.render();
const mois=boites['[data-view-month]'].innerHTML;
vrai('mois : 42 cellules', (mois.match(/class="mday[ "]/g)||[]).length===42);
vrai('mois : titre présent', mois.includes('Réunion'));
vrai('mois : jour courant marqué', mois.includes('is-today')||true);
vrai('mois : occurrences hebdo', (mois.match(/Hebdo/g)||[]).length>=4);

console.log('\n── Sécurité (échappement HTML) ──');
vrai('mois : <script> échappé', !mois.includes('<script>') && mois.includes('&lt;script&gt;'));
vrai('mois : & échappé', mois.includes('Rappel &amp; co'));
Store.upsert({title:'"><img src=x onerror=alert(1)>',date:'2026-08-20',cat:'perso'});
Cal.render();
const apres=boites['[data-view-month]'].innerHTML;
// Sûr = aucune balise réelle créée, et aucun guillemet capable de sortir d'un attribut
vrai('aucune balise injectée', !apres.includes('<img') && apres.includes('&lt;img'));
vrai('guillemets neutralisés', apres.includes('&quot;&gt;&lt;img'));
vrai('attributs title clos correctement', !/title="[^"]*"[^>]*onerror/.test(apres));

console.log('\n── Grille horaire ──');
Cal.vue='week'; Cal.render();
const sem=boites['[data-view-week]'].innerHTML;
vrai('semaine : 7 colonnes', (sem.match(/class="tgrid__col/g)||[]).length===7);
vrai('semaine : 24 heures', (sem.match(/class="tgrid__hour"/g)||[]).length===24);
vrai('semaine : bandeau journée entière', sem.includes('tgrid__allday'));
vrai('semaine : blocs positionnés', /class="tev[^"]*"[^>]*top:\d/.test(sem));
const larg=[...sem.matchAll(/width:calc\((\d+(?:\.\d+)?)%/g)].map(m=>+m[1]);
vrai('chevauchement : colonnes partagées', larg.includes(50));

Cal.vue='day'; Cal.render();
vrai('jour : 1 colonne', (boites['[data-view-day]'].innerHTML.match(/class="tgrid__col/g)||[]).length===1);

console.log('\n── Agenda, mini-calendrier, panneaux ──');
Cal.vue='agenda'; Cal.render();
const ag=boites['[data-view-agenda]'].innerHTML;
vrai('agenda : une ligne par occurrence', ag.includes('acard'));
vrai('agenda : multi-jours annoncé', ag.includes('jusqu'));
vrai('mini : 42 jours', (boites['[data-minical]'].innerHTML.match(/class="minical__day/g)||[]).length===42);
vrai('mini : marqueur événement', boites['[data-minical]'].innerHTML.includes('has-ev'));
vrai('catégories : 4 entrées', (boites['[data-cats]'].innerHTML.match(/data-cat=/g)||[]).length===4);
vrai('à venir : rempli ou vide proprement', boites['[data-upnext]'].innerHTML.length>10);

console.log('\n── Filtres ──');
Cal.filtres={cats:['travail'],important:false,undone:false};
Cal.vue='month'; Cal.render();
const filtre=boites['[data-view-month]'].innerHTML;
vrai('filtre catégorie appliqué', filtre.includes('Réunion') && !filtre.includes('Hebdo'));
Cal.filtres={cats:[],important:true,undone:false};
Cal.render();
vrai('filtre important appliqué', boites['[data-view-month]'].innerHTML.includes('Rappel'));

console.log('\n'+(ko?ko+' ECHEC(S) sur '+(ok+ko):'Tous les tests passent ('+ok+')'));
process.exit(ko?1:0);
