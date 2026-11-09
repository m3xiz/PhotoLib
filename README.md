# PhotoLib — recherche de photos par tags/dates/nom

Architecture distribuée :

```
[Serveur Samba]                              [yara.home.lan]
  photos (local, rapide)                       Apache (reverse proxy + sert /photos)
    │                                             │
  indexeur Python (scan, exiftool, thumbs)        webapp FastAPI (lecture seule)
    │  écrit                                      │  lit
  index.db (SQLite) ── rsync (SSH) ──────────►   index.db (copie)
  thumbnails/        ── rsync (SSH) ──────────►   thumbnails/ (copie)
                                                  montage CIFS RO du même share
                                                  (pour servir les photos en HTTP)
```

- L'indexeur tourne **sur le serveur Samba** : accès disque local aux 90000 photos (pas de traversée réseau pendant le scan).
- La base SQLite + les miniatures sont **synchronisées vers yara** après chaque scan (rsync via SSH, écriture atomique côté yara).
- Le webapp sur yara ne fait **que lire** cette copie — jamais d'écriture concurrente sur la base "source de vérité".
- yara monte aussi le share en CIFS **lecture seule**, uniquement pour qu'Apache serve les photos en taille réelle via HTTP (`/photos/...`).

## 1. Prérequis

Ça dépend de la façon dont vous déployez l'indexeur (Docker ou installation
directe) — inutile d'installer des paquets qui ne servent à rien sur un
hôte donné.

**Serveur Samba (indexeur) — si Docker (option A, recommandée) :**

```bash
# Seul Docker est nécessaire ; exiftool/python/rsync sont déjà dans l'image
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # puis se reconnecter
```

**Serveur Samba (indexeur) — si installation directe (option B) :**

```bash
sudo apt install python3-venv python3-pip libimage-exiftool-perl rsync
```

**Serveur web (yara) — dans tous les cas :**

```bash
sudo apt install python3-venv python3-pip rsync apache2 cifs-utils
sudo a2enmod proxy proxy_http
```

(`rsync` est nécessaire ici aussi : même si c'est l'indexeur qui initie la
synchro, le binaire `rsync` doit être présent des deux côtés. `exiftool`
n'est en revanche jamais utilisé côté webapp, pas besoin de l'installer ici.)

## 2. Installation de l'indexeur (serveur Samba)

### Option A — Docker (recommandé si vous préférez des conteneurs)

```bash
cd photolib/indexer
cp .env.example .env
nano .env   # PHOTO_ROOT (chemin réel des photos), DATA_DIR, SSH_KEY_DIR

cp config.docker.example.yaml config.yaml
nano config.yaml   # sync.target_host, ssh_key, etc.

mkdir -p "$(grep DATA_DIR .env | cut -d= -f2)"/logs
mkdir -p "$(grep SSH_KEY_DIR .env | cut -d= -f2)"

# Clé SSH dédiée à la synchro vers le webapp
ssh-keygen -t ed25519 -f "$(grep SSH_KEY_DIR .env | cut -d= -f2)/id_ed25519_photolib" -N ""
ssh-copy-id -i "$(grep SSH_KEY_DIR .env | cut -d= -f2)/id_ed25519_photolib.pub" photolib@yara.home.lan

docker compose up -d --build
```

Ça démarre deux conteneurs : `photolib-indexer-api` (port 8899, API de
scan à la demande -- utilisée par le bouton "Rescanner maintenant" du
webapp) et `photolib-indexer-cron` (conteneur minimaliste Alpine/cron qui
appelle cette API chaque nuit à `SCAN_HOUR`, réglable dans
`docker-compose.yml`). Toute la logique de scan passe par un seul chemin
de code (`indexer-api`), que ce soit un déclenchement manuel ou planifié.

Premier scan complet manuel (sans attendre la nuit) :

```bash
curl -X POST http://localhost:8899/trigger-scan
curl http://localhost:8899/status
```

Logs :

```bash
docker compose logs -f indexer-api
docker compose logs -f indexer-cron   # niveau réglable via CRON_LOG_LEVEL
                                       # (info / verbose / quiet) dans docker-compose.yml
```

### Option B — Installation directe (sans Docker)

```bash
sudo useradd -r -m -s /bin/bash photolib
sudo mkdir -p /opt/photolib /var/lib/photolib /var/log/photolib
sudo cp -r indexer /opt/photolib/
cd /opt/photolib/indexer
sudo -u photolib python3 -m venv venv
sudo -u photolib ./venv/bin/pip install -r requirements.txt

sudo cp config.example.yaml config.yaml
sudo nano config.yaml   # adapter photo_root, sync.target_host, ssh_key, etc.
sudo chown -R photolib:photolib /opt/photolib /var/lib/photolib /var/log/photolib
```

Générer une clé SSH dédiée pour la synchro, et l'autoriser sur yara
(compte `photolib` là-bas, avec un `authorized_keys` restreint si possible) :

```bash
sudo -u photolib ssh-keygen -t ed25519 -f /home/photolib/.ssh/id_ed25519_photolib -N ""
sudo -u photolib ssh-copy-id -i /home/photolib/.ssh/id_ed25519_photolib.pub photolib@yara.home.lan
```

Premier scan complet manuel (peut prendre du temps pour 90000 photos) :

```bash
cd /opt/photolib/indexer
sudo -u photolib ./venv/bin/python3 run_scan.py --kind scheduled
```

Activer le scan planifié + l'API de déclenchement :

```bash
sudo cp systemd/*.service systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now photolib-trigger-api.service
sudo systemctl enable --now photolib-scan.timer
```

## 3. Installation du webapp (yara)

Monter le share en lecture seule :

```bash
sudo mkdir -p /mnt/photolib-share
echo "//SAMBA_SERVER/PARTAGE /mnt/photolib-share cifs ro,credentials=/etc/photolib-smb-creds,uid=www-data,gid=www-data,iocharset=utf8 0 0" | sudo tee -a /etc/fstab
sudo nano /etc/photolib-smb-creds   # username=... / password=...
sudo chmod 600 /etc/photolib-smb-creds
sudo mount -a
```

Installer le webapp :

```bash
sudo useradd -r -m -s /bin/bash photolib
sudo mkdir -p /opt/photolib /var/lib/photolib-web
sudo cp -r webapp /opt/photolib/
cd /opt/photolib/webapp
sudo -u photolib python3 -m venv venv
sudo -u photolib ./venv/bin/pip install -r requirements.txt

sudo cp config.example.yaml config.yaml
sudo nano config.yaml   # indexer_trigger_url = http://IP_SERVEUR_SAMBA:8899
sudo chown -R photolib:photolib /opt/photolib /var/lib/photolib-web
```

Récupérer la clé publique SSH de l'indexeur (générée à l'étape 2) dans
`~photolib/.ssh/authorized_keys` sur yara.

Activer le service + Apache :

```bash
sudo cp systemd/photolib-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now photolib-web.service

sudo cp apache/photolib.conf /etc/apache2/sites-available/photolib.conf
sudo nano /etc/apache2/sites-available/photolib.conf   # adapter le range IP LAN
sudo a2ensite photolib
sudo systemctl reload apache2
```

Ouvrir `http://photolib.home.lan/` (ou l'IP de yara).

## 4. Utilisation

- **Installer sur mobile ("Ajouter à l'écran d'accueil")** : sur Android (Chrome/Samsung Internet) ou iPad/iPhone (Safari), menu du navigateur → "Ajouter à l'écran d'accueil". Ça crée une icône dédiée qui ouvre l'interface en plein écran, sans barre d'adresse. C'est une installation manuelle (PWA "niveau 1", pas une app du Play/App Store) : aucune maintenance particulière, elle se met à jour automatiquement en même temps que le webapp lui-même. ⚠️ Comme le déploiement de ce projet est en HTTP simple (LAN de confiance, pas de certificat), l'invite d'installation **automatique** de Chrome (bannière "Installer l'application") ne s'affichera pas — HTTPS est requis pour ça. L'ajout **manuel** via le menu du navigateur fonctionne quand même normalement.
- **Recherche** : ajouter des mots-clés (autocomplétion sur les ~1000 tags existants), choisir ET (toutes les photos doivent avoir tous les mots-clés) ou OU (au moins un), filtrer par plage de dates de prise de vue, nom de fichier, **titre** et/ou **légende** (Exif/IPTC/XMP, priorité XMP). Tous ces groupes se combinent toujours en ET entre eux.
- **Miniatures** : générées et mises en cache lors du scan (RAW compris, via extraction de la preview embarquée par exiftool — c'est le seul usage de "preview" dans ce projet, à ne pas confondre avec un fichier intermédiaire pour la visionneuse, qui n'existe pas).
- **Clic sur une photo** : ouvre une visionneuse plein écran **dans la page** (jamais de nouvel onglet).
  - **JPEG/PNG/GIF/WEBP** : affiché directement (le fichier original, adapté à la taille du navigateur via CSS `object-fit: contain`).
  - **RAW (CR2, NEF, ARW, DNG, RAF, ORF, RW2...)** : non affichable par un navigateur — un message l'indique, avec un lien direct pour télécharger l'original.
  - Bouton **"ℹ️ Infos"** : dépliable, affiche titre, légende, date de prise de vue et mots-clés.
  - Lien **"⤓ Original"** : toujours disponible, ouvre/télécharge le fichier source en taille réelle dans un nouvel onglet.
  - Fermeture : bouton, touche **Échap**, ou clic en dehors de l'image.
- **Bouton "Rescanner maintenant"** : déclenche un scan immédiat côté indexeur (en plus du scan planifié nocturne), puis synchronise vers yara. Sans limite de durée par défaut (voir `SCAN_TIMEOUT_SECONDS` si vous voulez un garde-fou).

## 5. Détection des mises à jour

Comme signalé, une "vieille" photo peut être retaggée à tout moment. Le
scan compare pour **chaque fichier** :

- le `mtime` du fichier image,
- le `mtime` de son `.xmp` sidecar (s'il existe).

Si l'un des deux a changé depuis le dernier scan, le fichier est
réindexé — peu importe son ancienneté. En cas de conflit entre les tags
embarqués et le `.xmp`, le `.xmp` prévaut (dates, mots-clés, titre,
légende), comme demandé.

Le scan planifié (nuit, via `photolib-scan.timer`, modifiable dans le
fichier `.timer`) fait un scan complet et nettoie les fichiers disparus du
share. Le bouton manuel déclenche le même scan complet à la demande.

### Si vous avez déjà une base indexée (mise à jour du logiciel)

Les champs `title`/`caption` sont ajoutés automatiquement à la base
existante au prochain démarrage (migration `ALTER TABLE`, sans perte de
données). Si votre base a été indexée avec une version antérieure de ce
projet qui gérait `camera_make`/`camera_model`/`preview_path`, ces colonnes
restent en place (inoffensives, plus jamais lues ni écrites) — inutile de
les supprimer manuellement.

Comme le scan ne retraite que les fichiers **modifiés**, les photos déjà
indexées avant cette mise à jour n'auront ni titre ni légende tant qu'elles
n'auront pas été rescannées. Pour forcer leur backfill :

```bash
sqlite3 /var/lib/photolib/index.db "UPDATE photos SET mtime=0, xmp_mtime=0;"
```

puis relancez un scan complet (voir section 3 ci-dessus pour le déclencher).
Les miniatures existantes n'ont pas besoin d'être supprimées cette fois
(seuls `title`/`caption` manquent, le scan les rajoute).

## 6. Points d'attention / pistes d'amélioration

- **Timeout du scan déclenché via l'API** : corrigé -- une version
  antérieure avait une limite codée en dur à 3600s (1h) qui tuait de force
  tout scan plus long, ce qui arrive nécessairement sur un gros volume de
  photos. Pas de limite par défaut désormais ; réglable via la variable
  d'environnement `SCAN_TIMEOUT_SECONDS` du conteneur `indexer-api` si vous
  voulez quand même un garde-fou dur.
- **Mémoire sur un hôte contraint** : le scan traite désormais les photos par
  paquets bornés (`scan_chunk_size`, 300 par défaut) et commit en base après
  chaque paquet, au lieu de tout garder en mémoire jusqu'à la fin — ça évite
  qu'un scan de 90000 photos fasse grossir indéfiniment la consommation
  mémoire. Si votre hôte a peu de RAM (repérable via `dmesg | grep -i "out of memory"` après un scan qui semble "disparaître" sans erreur applicative),
  réduisez aussi `worker_threads` (2 par défaut dans `config.docker.example.yaml`)
  et gardez les limites `mem_limit`/`memswap_limit` du `docker-compose.yml` --
  mieux vaut un scan plus lent qu'un OOM qui tue aussi d'autres services sur
  la machine. Un fichier swap sur l'hôte est aussi une bonne protection
  supplémentaire si vous n'en avez pas déjà un.
- **Premier scan** : avec 90000 photos (dont RAW), la première indexation
  complète peut prendre plusieurs heures (extraction exiftool + génération
  des miniatures). Les scans suivants ne retraitent que les fichiers
  modifiés, donc bien plus rapides.
- **Performance exiftool** : ce projet appelle `exiftool` une fois par
  fichier modifié. Pour aller plus vite sur de très gros volumes de
  changements, on peut migrer vers le mode `-stay_open` d'exiftool
  (process persistant, traite un flux de fichiers) — non fait ici pour
  garder le code simple, mais c'est la première optimisation à envisager
  si les scans deviennent trop longs.
- **Sécurité réseau** : l'API de déclenchement (port 8899) et l'accès web
  ne sont pas authentifiés, en cohérence avec un usage LAN uniquement.
  Si le réseau n'est pas totalement de confiance, ajouter un pare-feu
  (ufw) limitant ces ports au sous-réseau local.
- **Mots-clés hiérarchiques** : non gérés (confirmé non nécessaire), les
  tags sont stockés à plat.