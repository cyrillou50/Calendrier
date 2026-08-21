# Calendrier

Un calendrier personnel pour noter ce qui compte et organiser ses journées.
Le site est **statique** (GitHub Pages), les données sont **sauvegardées sur ton VPS**.

---

## Ce que ça fait

- **4 vues** — Mois, Semaine, Jour, Agenda
- **Événements complets** — titre, horaires, journée entière, plusieurs jours, lieu, notes, catégorie, répétition (jour / semaine / mois / an)
- **Notes importantes** — marque un événement comme important, il ressort visuellement ; coche-le quand c'est fait
- **Recherche** instantanée sur tout le contenu
- **Catégories personnalisables** — crée les tiennes, couleur comprise ; elles suivent le calendrier partagé
- **Filtres** par catégorie, par importance, masquage des éléments terminés
- **Thème clair et sombre**, responsive jusqu'au mobile
- **Comptes** — pseudo + mot de passe haché (scrypt), sessions révocables
- **Partage à plusieurs** — invite quelqu'un par code, en lecture seule ou avec droit de modification
- **Présence en direct** — pastille verte sur les personnes actuellement sur le calendrier
- **Synchronisation multi-appareils** avec résolution de conflits
- **Fonctionne hors ligne** — tout est en local d'abord, la synchro rattrape ensuite
- **Exports** JSON et `.ics` (importable dans Google Agenda, Outlook, Apple Calendrier)

---

## Comment c'est organisé

```
   Ton navigateur                    GitHub Pages              Ton VPS
  ┌───────────────┐                ┌──────────────┐        ┌──────────────────┐
  │  Application  │◄── HTTPS ─────►│  index.html  │        │  Nginx (HTTPS)   │
  │               │                │  assets/     │        │        │         │
  │ localStorage  │                └──────────────┘        │        ▼         │
  │  (hors ligne) │                                        │  API Node.js     │
  │       │       │                                        │        │         │
  │       └───────┼──── HTTPS ─────────────────────────────┼──►  SQLite       │
  │   synchro     │        /api/sync                       │  (1 fichier)     │
  └───────────────┘                                        └──────────────────┘
```

GitHub Pages ne sert que des fichiers statiques : il ne peut ni gérer les comptes
ni stocker les données. C'est le rôle du VPS.

> ### ⚠️ Le point à comprendre avant de commencer
>
> GitHub Pages est servi en **HTTPS**. Un navigateur **refuse** qu'une page HTTPS
> appelle une adresse en `http://`. Ton API a donc besoin d'un **nom de domaine
> avec un certificat** — une simple adresse IP ne fonctionnera pas.
>
> Le certificat est gratuit (Let's Encrypt) et le script d'installation s'en occupe.
> Si tu n'as pas de domaine, la section [Pas de domaine ?](#pas-de-domaine-) donne
> une solution gratuite.

---

## Étape 1 — Essayer tout de suite

Aucune installation nécessaire :

**Double-clique sur `index.html`**, puis choisis *« Utiliser sans compte »*.

L'application est pleinement fonctionnelle : tes événements sont enregistrés dans
le navigateur. Tu pourras les rattacher à un compte plus tard, l'application te le
proposera à ta première connexion.

---

## Étape 2 — Publier le site sur GitHub Pages

### 2.1 · Créer le dépôt

Sur [github.com/new](https://github.com/new), crée un dépôt nommé par exemple
`calendrier`. Laisse-le **vide** (ni README, ni .gitignore).

### 2.2 · Envoyer les fichiers

Depuis ce dossier :

```bash
git init
git add .
git commit -m "Calendrier : première version"
git branch -M main
git remote add origin https://github.com/TON-PSEUDO/calendrier.git
git push -u origin main
```

Le fichier `.gitignore` exclut déjà `server/.env` et la base de données :
**aucun secret ne part sur GitHub.**

### 2.3 · Activer Pages

Dans le dépôt : **Settings** → **Pages** (menu de gauche)

| Champ | Valeur |
|---|---|
| Source | `Deploy from a branch` |
| Branch | `main` — dossier `/ (root)` |

Clique sur **Save**. Après une ou deux minutes, ton site est en ligne :

```
https://TON-PSEUDO.github.io/calendrier/
```

> Le dossier `server/` se retrouve aussi sur GitHub Pages, mais il n'y est jamais
> exécuté — ce ne sont que des fichiers texte inertes. C'est sans risque, et ça te
> permet de tout garder dans un seul dépôt.

---

## Étape 3 — Installer l'API sur ton VPS

### 3.1 · Faire pointer un domaine

Chez ton registraire (OVH, Gandi, Cloudflare…), crée un enregistrement **A** :

| Type | Nom | Valeur |
|---|---|---|
| A | `api` | l'adresse IP de ton VPS |

Tu obtiens `api.mondomaine.fr`. Attends que ça se propage (quelques minutes) :

```bash
dig +short api.mondomaine.fr      # doit afficher l'IP de ton VPS
```

### 3.2 · Lancer l'installation

En SSH sur le VPS :

```bash
git clone https://github.com/TON-PSEUDO/calendrier.git
cd calendrier/server/deploy
sudo bash install.sh api.mondomaine.fr https://TON-PSEUDO.github.io
```

> ⚠️ Le deuxième argument est l'**origine** : uniquement `https://` + le domaine.
> **Sans** le `/calendrier` final. C'est une règle du navigateur, pas un détail.

Le script installe Node.js 24, crée un utilisateur système dédié, déploie l'API,
**lance les tests**, configure systemd, Nginx, le certificat HTTPS, le pare-feu et
la sauvegarde quotidienne.

L'API n'a **aucune dépendance npm** : elle n'utilise que les modules intégrés à
Node.js. Rien à compiler, rien à télécharger, aucune faille de chaîne
d'approvisionnement.

### 3.3 · Vérifier

```bash
curl https://api.mondomaine.fr/api/health
# {"ok":true,"version":"1.0.0","inscriptions":true,"heure":...}
```

---

## Étape 4 — Relier le site à ton VPS

L'adresse de l'API est inscrite dans le code, en tête de
[`assets/js/api.js`](assets/js/api.js) :

```js
var SERVEUR_DEFAUT = 'https://api.mondomaine.fr';
```

Remplace cette ligne par ton domaine, pousse, et l'application s'y connecte
sans que personne ait à saisir quoi que ce soit. Il ne reste qu'à ouvrir le
site et à créer ton compte.

Si tu utilisais le mode local, l'application te propose de récupérer tes événements
existants. Accepte : ils sont rattachés à ton compte et sauvegardés sur le VPS.

### Fermer les inscriptions

Une fois **ton** compte créé, empêche les autres d'en créer un :

```bash
sudo sed -i 's/ALLOW_REGISTRATION=true/ALLOW_REGISTRATION=false/' /opt/calendrier/server/.env
sudo systemctl restart calendrier-api
```

Ton serveur devient privé. Tu pourras toujours te connecter, mais plus personne
ne pourra s'inscrire.

---

## Sauvegardes

### Automatiques

Une sauvegarde tourne **chaque nuit à 3h15**, avec 30 jours de rétention :

```bash
ls -lh /var/backups/calendrier/          # les sauvegardes
cat /var/log/calendrier-backup.log       # le journal
sudo /usr/local/bin/calendrier-backup    # une sauvegarde immédiate
```

Le script utilise `sqlite3 .backup`, la seule méthode fiable à chaud : copier
directement le fichier `.db` pendant une écriture produirait une base corrompue.
Chaque sauvegarde est vérifiée (`PRAGMA integrity_check`) avant d'être conservée.

### Restaurer

```bash
sudo bash /opt/calendrier/server/scripts/restore.sh \
     /var/backups/calendrier/calendrier-2026-08-20_031500.db.gz
```

La base actuelle est mise de côté avant remplacement — une erreur reste rattrapable.

### Copie hors-site

Une sauvegarde sur le même serveur ne protège pas d'une panne de disque.
Décommente une des lignes en fin de `server/scripts/backup.sh` :

```bash
rsync -az "$FICHIER.gz" utilisateur@autre-machine:/sauvegardes/calendrier/
```

### Depuis le navigateur

**Compte & sauvegarde** → **Exporter (.json)** produit un fichier complet,
réimportable. Utile avant une manipulation risquée.

---

## Partager son calendrier

Tout se passe dans le **menu des calendriers**, dans la barre du haut. Il est
toujours visible une fois connecté, même quand tu n'as qu'un seul calendrier.

**Inviter quelqu'un** — menu → *Inviter quelqu'un sur le mien…* → choisis le
droit accordé. Un code apparaît (`XXXX-XXXX`), transmets-le.

**Rejoindre** — la personne crée son compte, ouvre le même menu, choisit
*Rejoindre avec un code…* et saisit ce que tu lui as envoyé.

Le menu liste ensuite tous les calendriers accessibles : un clic suffit pour
basculer de l'un à l'autre. Les modifications se synchronisent entre tous ceux
qui y ont accès, avec la même règle de conflit que pour un calendrier
personnel : la version la plus récente l'emporte.

| | Lecture seule | Peut modifier | Propriétaire |
|---|---|---|---|
| Voir les événements | ✓ | ✓ | ✓ |
| Créer, modifier, supprimer | | ✓ | ✓ |
| Inviter et retirer des accès | | | ✓ |

**Pourquoi un code plutôt qu'un pseudo :** inviter par pseudo obligerait le
serveur à répondre « ce pseudo existe » ou « il n'existe pas », ce qui permet de
deviner qui a un compte. Le code ne révèle rien.

Chaque code est **à usage unique**, valable **7 jours**, et annulable à tout
moment. Dans **Compte & sauvegarde**, le propriétaire voit la liste de tous ceux qui
ont accès à son calendrier, avec une **pastille verte** quand la personne y est
en ce moment, ou « vu il y a X min » sinon. Le bouton ✕ retire l'accès
immédiatement. Une pastille apparaît aussi sur le bouton des calendriers dès
que quelqu'un d'autre est en train de consulter le même calendrier que toi.

La présence est tenue en mémoire du serveur, jamais écrite sur disque : elle
n'a aucun sens après un redémarrage, et ça évite une écriture par minute et par
personne. Elle expire d'elle-même au bout de deux minutes sans signe de vie, et
un onglet en arrière-plan cesse d'émettre — pas de fausse présence.

Le propriétaire peut retirer un accès quand il veut ; un invité peut se
retirer lui-même. Personne ne peut réinviter sur un calendrier qui n'est pas le
sien — le partage ne se propage pas en cascade.

## Raccourcis clavier

| Touche | Action |
|---|---|
| `N` | Nouvel événement |
| `M` / `S` / `J` / `A` | Vue Mois / Semaine / Jour / Agenda |
| `←` `→` | Période précédente / suivante |
| `T` | Revenir à aujourd'hui |
| `/` | Recherche |
| `Ctrl` + `S` | Synchroniser maintenant |
| `Ctrl` + `Entrée` | Enregistrer l'événement en cours |
| `Échap` | Fermer |

---

## Tests

217 tests couvrent le calcul des dates, les récurrences, le rendu des vues,
l'échappement HTML, l'API, le partage et ses droits, l'isolation entre comptes,
la résolution de conflits et les pièges silencieux du navigateur.

```bash
node test/run.js             # tout
node test/store.test.js      # dates, récurrences, catégories     (53)
node test/render.test.js     # rendu des 4 vues, sécurité XSS     (25)
node test/lint.test.js       # pièges du navigateur                (9)
node server/test/migration.js# migration de la base               (14)
node server/test/e2e.js      # API de bout en bout               (116)
```

`lint.test.js` attrape une famille d'erreurs que rien d'autre ne voit :
`form.title` ne renvoie pas le champ nommé « title » mais l'attribut HTML du
formulaire, et une action déléguée à `#app` n'atteint jamais les modales, qui
vivent en dehors. Dans les deux cas la page se charge sans erreur visible et
les boutons restent inertes.

Node.js 24+ est requis pour les lancer (pas pour utiliser le site).

---

## Sécurité

- Mots de passe hachés en **scrypt** avec sel aléatoire — jamais stockés en clair
- Comparaison à **temps constant** (`timingSafeEqual`)
- Jetons de session **opaques et révocables**, hachés en base, valables 90 jours
- **CORS strict** : seule l'origine que tu déclares peut appeler l'API
- **Limitation de débit** sur la connexion, côté Node *et* côté Nginx
- Message d'erreur **identique** que le compte existe ou non
- Toutes les entrées sont **validées et bornées** côté serveur
- Tout contenu affiché est **échappé** (testé contre l'injection HTML)
- L'API n'écoute que sur `127.0.0.1` — elle n'est joignable qu'à travers Nginx
- Service systemd **durci** (`ProtectSystem=strict`, utilisateur non privilégié)
- **Zéro dépendance externe** côté serveur

Le mot de passe de ton compte ne quitte jamais ton navigateur autrement qu'en
HTTPS, et n'est jamais écrit dans les journaux.

---

## Pas de domaine ?

Deux options gratuites :

**DuckDNS** — [duckdns.org](https://www.duckdns.org), connexion avec GitHub,
choisis un sous-domaine, indique l'IP de ton VPS. Tu obtiens
`monnom.duckdns.org`, utilisable directement :

```bash
sudo bash install.sh monnom.duckdns.org https://TON-PSEUDO.github.io
```

**nip.io** — sans inscription : `123.45.67.89.nip.io` résout automatiquement vers
`123.45.67.89`. Pratique pour tester, moins pour durer.

---

## Dépannage

| Symptôme | Cause et solution |
|---|---|
| *Serveur injoignable* | `curl https://api.mondomaine.fr/api/health` depuis ta machine. Sans réponse : DNS ou pare-feu. |
| Erreur **CORS** dans la console | `ALLOWED_ORIGINS` ne correspond pas exactement. Il faut `https://pseudo.github.io`, sans chemin ni barre finale. Puis `systemctl restart calendrier-api`. |
| *Mixed content* / requête bloquée | L'adresse de l'API est en `http://`. Il faut `https://`. |
| Le site affiche l'ancienne version | Cache GitHub Pages : `Ctrl` + `F5`. Le déploiement prend 1 à 2 minutes. |
| *Les inscriptions sont fermées* | Normal si tu as mis `ALLOW_REGISTRATION=false`. Repasse-le à `true` le temps de créer le compte. |
| L'API ne démarre pas | `journalctl -u calendrier-api -n 50` |
| `node:sqlite` indisponible | Node trop ancien. Node 24+ requis : `node -v` pour vérifier. |
| Événements absents sur un 2ᵉ appareil | Connecte-toi avec le même compte, puis `Ctrl` + `S`. |

Commandes utiles sur le VPS :

```bash
sudo systemctl status calendrier-api      # état
sudo systemctl restart calendrier-api     # redémarrer
sudo journalctl -u calendrier-api -f      # journaux en direct
```

---

## Structure du projet

```
Calendrier/
├── index.html               Application (page unique)
├── assets/
│   ├── css/style.css        Thèmes clair/sombre, mise en page, responsive
│   └── js/
│       ├── icons.js         Icônes SVG intégrées
│       ├── store.js         Modèle, dates, récurrences, localStorage
│       ├── api.js           Dialogue avec le VPS, synchronisation
│       ├── ui.js            Modales, notifications, échappement HTML
│       ├── calendar.js      Rendu des 4 vues
│       └── app.js           Démarrage, interactions, connexion, exports
├── test/                    Tests du client
├── server/
│   ├── src/
│   │   ├── server.js        Routes HTTP, validation
│   │   ├── db.js            Schéma SQLite, transactions
│   │   └── auth.js          Comptes, scrypt, sessions, débit
│   ├── test/e2e.js          Tests de l'API
│   ├── scripts/             backup.sh · restore.sh
│   ├── deploy/              install.sh · systemd · nginx
│   └── .env.example         Configuration commentée
└── .gitignore               Exclut .env et la base de données
```

---

## Notes techniques

**Local d'abord.** Toute modification est écrite en `localStorage` immédiatement,
puis poussée vers le serveur 2,5 secondes plus tard. L'interface ne dépend jamais
du réseau.

**Conflits.** Chaque événement porte un `updatedAt`. En cas de divergence entre
deux appareils, la version la plus récente l'emporte.

**Suppressions.** Elles laissent une « pierre tombale » (`deleted = 1`) au lieu de
disparaître, sinon un appareil hors ligne ressusciterait l'événement à sa prochaine
synchronisation.

**Curseur.** Le serveur numérote chaque écriture avec un compteur monotone plutôt
qu'un horodatage : pas de collision, pas de dérive d'horloge entre appareils.

**Récurrences.** La n-ième occurrence est toujours calculée depuis la date
d'origine. Un événement mensuel du 31 janvier donne 28 février puis **31 mars** —
et non 28 mars comme le produirait un calcul de proche en proche.
