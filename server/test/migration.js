const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');

const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'calmig-'));
const F=path.join(TMP,'ancienne.db');

// ── Base à l'ANCIEN format, avec un compte et ses données ──
{
  const db=new DatabaseSync(F);
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '', pass TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE events (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL, end_date TEXT, all_day INTEGER NOT NULL DEFAULT 0, start_time TEXT, end_time TEXT,
      cat TEXT NOT NULL DEFAULT 'perso', important INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
      repeat TEXT NOT NULL DEFAULT 'none', skip TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL, PRIMARY KEY (user_id,id));
    CREATE TABLE meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
    INSERT INTO meta VALUES ('seq', 42);
    INSERT INTO users VALUES ('u1','cyrillou50@outlook.com','Cyril','hash',1000);
    INSERT INTO sessions VALUES ('jeton1','u1',1000,1000,9999999999999);
    INSERT INTO events VALUES ('u1','ev-1','Rendez-vous','','','2026-08-20',NULL,0,'09:00','10:00','perso',0,0,'none','',1000,1000,0,1);
    INSERT INTO events VALUES ('u1','ev-2','Reunion','notes','Paris','2026-08-21',NULL,1,NULL,NULL,'travail',1,0,'weekly','2026-08-28',1000,1000,0,2);
  `);
  db.close();
}

let ok=0,ko=0;
const eq=(n,a,b)=>{ if(JSON.stringify(a)===JSON.stringify(b)){ok++;console.log('  ok   '+n);}
  else{ko++;console.log('  KO   '+n+'\n        attendu '+JSON.stringify(b)+'\n        obtenu  '+JSON.stringify(a));} };

// ── Charge db.js : la migration doit se declencher ──
process.env.DATA_DIR=TMP;
process.env.DB_PATH=F;
const {db}=require(path.join(__dirname,'..','src','db.js'));

console.log('\n── Apres migration ──');
const cols=db.prepare('PRAGMA table_info(users)').all().map(c=>c.name);
eq('colonne pseudo presente', cols.includes('pseudo'), true);
eq('colonne email supprimee', cols.includes('email'), false);

const u=db.prepare('SELECT * FROM users').all();
eq('compte conserve', u.length, 1);
eq('pseudo derive de l email', u[0].pseudo, 'cyrillou50');
eq('mot de passe intact', u[0].pass, 'hash');
eq('identifiant inchange', u[0].id, 'u1');

eq('evenements conserves', db.prepare('SELECT COUNT(*) c FROM events').get().c, 2);
eq('contenu intact', db.prepare("SELECT title FROM events WHERE id='ev-2'").get().title, 'Reunion');
eq('recurrence intacte', db.prepare("SELECT repeat,skip FROM events WHERE id='ev-2'").get().skip, '2026-08-28');
eq('sessions conservees', db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 1);
eq('curseur preserve', db.prepare("SELECT v FROM meta WHERE k='seq'").get().v, 42);

// Insensibilite a la casse + cle etrangere toujours active
eq('recherche insensible a la casse',
   db.prepare('SELECT id FROM users WHERE pseudo = ?').get('CYRILLOU50').id, 'u1');
eq('cles etrangeres reactivees',
   db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);

// Relancer ne doit rien casser
db.close();
delete require.cache[require.resolve(path.join(__dirname,'..','src','db.js'))];
const {db:db2}=require(path.join(__dirname,'..','src','db.js'));
eq('second chargement sans effet', db2.prepare('SELECT COUNT(*) c FROM users').get().c, 1);
db2.close();

try{ fs.rmSync(TMP,{recursive:true,force:true}); }catch{}
console.log('\n'+(ko?ko+' ECHEC(S) sur '+(ok+ko):'Tous les tests passent ('+ok+')'));
process.exit(ko?1:0);
