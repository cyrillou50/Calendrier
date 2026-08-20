const fs=require('fs'),vm=require('vm');
const R=require('path').join(__dirname,'..')+'/';

// Faux navigateur minimal
const mem={};
const win={ localStorage:{ getItem:k=>k in mem?mem[k]:null, setItem:(k,v)=>{mem[k]=String(v)},
            removeItem:k=>{delete mem[k]} }, crypto:require('crypto'), console };
win.window=win;
const ctx=vm.createContext(win);
vm.runInContext(fs.readFileSync(R+'assets/js/store.js','utf8'),ctx,{filename:'store.js'});
const {Store,Dates:D}=ctx;

let ko=0,ok=0;
const eq=(nom,a,b)=>{ const A=JSON.stringify(a),B=JSON.stringify(b);
  if(A===B){ok++;console.log('  ok   '+nom);} else {ko++;console.log('  KO   '+nom+'\n        attendu '+B+'\n        obtenu  '+A);} };

console.log('\n── Dates ──');
eq('ymd',            D.ymd(new Date(2026,7,20)), '2026-08-20');
eq('parse->ymd',     D.ymd(D.parse('2026-02-29'.replace('29','28'))), '2026-02-28');
eq('addDays +12',    D.addDays('2026-08-20',12), '2026-09-01');
eq('addDays -20',    D.addDays('2026-08-20',-20), '2026-07-31');
eq('addMonths 31jan',D.addMonths('2026-01-31',1), '2026-02-28');
eq('addMonths bisex',D.addMonths('2024-01-31',1), '2024-02-29');
eq('addMonths +12',  D.addMonths('2026-01-31',12), '2027-01-31');
eq('lundi',          D.startOfWeek('2026-08-20'), '2026-08-17');
eq('lundi (dim)',    D.startOfWeek('2026-08-23'), '2026-08-17');
eq('diff',           D.diff('2026-08-01','2026-08-20'), 19);
eq('semaine ISO',    D.week('2026-01-01'), 1);
eq('mins',           D.mins('09:30'), 570);
eq('hhmm',           D.hhmm(570), '09:30');
eq('longDate',       D.longDate('2026-08-20'), 'jeudi 20 août 2026');

console.log('\n── Récurrences ──');
Store.open('test');
const base={title:'X',date:'2026-08-03',allDay:true,cat:'perso'};

const hebdo=Store.upsert({...base,title:'Hebdo',repeat:'weekly'});
let o=Store.occurrencesInRange('2026-08-01','2026-08-31').map(x=>x.date);
eq('hebdo août',     o, ['2026-08-03','2026-08-10','2026-08-17','2026-08-24','2026-08-31']);

o=Store.occurrencesInRange('2026-11-01','2026-11-30').map(x=>x.date);
eq('hebdo nov (saut)',o,['2026-11-02','2026-11-09','2026-11-16','2026-11-23','2026-11-30']);

Store.remove(hebdo.id);
const mens=Store.upsert({...base,title:'Mensuel',date:'2026-01-31',repeat:'monthly'});
o=Store.occurrencesInRange('2026-01-01','2026-05-31').map(x=>x.date);
eq('mensuel 31 (pas de dérive)',o,['2026-01-31','2026-02-28','2026-03-31','2026-04-30','2026-05-31']);

Store.skipOccurrence(mens.id,'2026-03-31');
o=Store.occurrencesInRange('2026-01-01','2026-05-31').map(x=>x.date);
eq('occurrence masquée',o,['2026-01-31','2026-02-28','2026-04-30','2026-05-31']);
Store.remove(mens.id);

const an=Store.upsert({...base,title:'Anniv',date:'2020-06-15',repeat:'yearly'});
o=Store.occurrencesInRange('2026-06-01','2026-06-30').map(x=>x.date);
eq('annuel 2026',o,['2026-06-15']);
Store.remove(an.id);

console.log('\n── Multi-jours ──');
const vac=Store.upsert({title:'Vacances',date:'2026-07-28',endDate:'2026-08-04',allDay:true,cat:'perso'});
o=Store.occurrencesInRange('2026-08-01','2026-08-31').map(x=>x.date);
eq('début hors plage',o,['2026-08-01','2026-08-02','2026-08-03','2026-08-04']);
const occ=Store.occurrencesInRange('2026-08-01','2026-08-31')[0];
eq('clé stable',occ.key, vac.id+'@2026-07-28');
eq('isStart faux',occ.isStart,false);
Store.remove(vac.id);

console.log('\n── Tri, filtres, recherche ──');
Store.upsert({title:'Réunion',date:'2026-08-20',startTime:'14:00',endTime:'15:00',cat:'travail'});
Store.upsert({title:'Sport',date:'2026-08-20',startTime:'08:00',endTime:'09:00',cat:'sante',important:true});
Store.upsert({title:'Férié',date:'2026-08-20',allDay:true,cat:'autre'});
eq('tri du jour',Store.onDay('2026-08-20').map(x=>x.ev.title),['Férié','Sport','Réunion']);
eq('filtre catégorie',Store.onDay('2026-08-20',{cats:['travail']}).map(x=>x.ev.title),['Réunion']);
eq('filtre important',Store.onDay('2026-08-20',{important:true}).map(x=>x.ev.title),['Sport']);
eq('recherche',Store.search('réun').map(x=>x.title),['Réunion']);
eq('recherche vide',Store.search('z'),[]);

console.log('\n── Persistance & synchro ──');
const n=Store.count();
Store.save(); Store._load();
eq('rechargement',Store.count(),n);
const av=Store.all()[0];
const dist={...av,title:'Modifié ailleurs',updatedAt:av.updatedAt+5000};
eq('fusion distante récente',Store.applyRemote([dist]),1);
eq('titre fusionné',Store.get(av.id).title,'Modifié ailleurs');
eq('fusion distante ancienne',Store.applyRemote([{...av,title:'Vieux',updatedAt:1}]),0);
const exp=Store.exportData();
eq('export',exp.events.length,Store.count());

console.log('\n'+(ko?ko+' ECHEC(S) sur '+(ok+ko):'Tous les tests passent ('+ok+')'));
process.exit(ko?1:0);
