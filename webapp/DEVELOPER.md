# PhotoLib Webapp — Documentation développeur

Interface de recherche en **lecture seule** sur la base SQLite produite par
l'indexeur (voir `indexer/DEVELOPER.md`). Backend FastAPI + frontend
vanilla JS (pas de framework, pas de build step).

## Sommaire

- [Vue d'ensemble](#vue-densemble)
- [Fichiers et responsabilités](#fichiers-et-responsabilités)
- [Référence API](#référence-api)
- [query_builder.py — logique de recherche](#query_builderpy--logique-de-recherche)
- [Frontend — architecture](#frontend--architecture)
- [Visionneuse plein écran (lightbox)](#visionneuse-plein-écran-lightbox)
- [Ce que le webapp NE fait PAS](#ce-que-le-webapp-ne-fait-pas)
- [Points d'extension courants](#points-dextension-courants)
- [Tests manuels / debug](#tests-manuels--debug)

## Vue d'ensemble

```
Apache (reverse proxy + sert /photos en direct depuis un montage CIFS)
      │
      ▼
FastAPI (app.py) ──lecture seule──► index.db (copie synchronisée ou partagée)
      │
      ▼
static/ (index.html + app.js + style.css) -- servi tel quel, pas de build
```

Le webapp **n'écrit jamais** dans la base — connexion SQLite explicitement
ouverte en mode lecture seule (`get_conn()`, `?mode=ro` dans l'URI). Toute
la logique d'écriture (scan, extraction, miniatures) vit côté indexeur.

## Fichiers et responsabilités

| Fichier | Rôle |
|---|---|
| `app.py` | Endpoints FastAPI, connexion DB read-only, proxy vers l'API de déclenchement de l'indexeur. |
| `query_builder.py` | Construction pure de SQL (aucun accès DB) à partir des paramètres de recherche. Fonction unique, testable isolément. |
| `static/index.html` | Structure de la page : formulaire de filtres + grille de résultats + markup de la lightbox. |
| `static/app.js` | Toute la logique : état de recherche, appels `fetch()`, rendu des résultats/pagination, visionneuse. |
| `static/style.css` | Thème sombre, grille responsive, styles de la lightbox. |

## Référence API

Toutes les routes sont préfixées `/api/`. Le reste (`/`) sert les fichiers
statiques via `StaticFiles(..., html=True)` (donc `index.html` par défaut).

### `GET /api/search`

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `keywords` | string | `""` | Mots-clés séparés par des virgules |
| `keyword_mode` | `and`\|`or` | `and` | Logique entre les mots-clés (voir `query_builder.py`) |
| `date_from` / `date_to` | string ISO | — | Plage sur `date_taken`. Toujours combiné en ET, indépendamment de `keyword_mode`. |
| `filename` | string | — | Sous-chaîne (LIKE) sur `filename` |
| `title` | string | — | Sous-chaîne (LIKE) sur `title` |
| `caption` | string | — | Sous-chaîne (LIKE) sur `caption` |
| `page` | int | `1` | |
| `page_size` | int | `page_size_default` (config) | Plafonné à `page_size_max` |

Réponse :
```json
{
  "total": 1234,
  "page": 1,
  "page_size": 60,
  "results": [
    {
      "id": 1, "relpath": "...", "filename": "...", "ext": "jpg",
      "date_taken": "2023-07-15T14:32:01", "title": "...", "caption": "...",
      "thumb_path": "a8/a893....jpg", "thumb_url": "/api/thumb/1",
      "photo_url": "/photos/2023/vacances/IMG_0001.jpg"
    }
  ]
}
```
`thumb_url`/`photo_url` sont calculés dans `row_to_dict()`, pas stockés en
base. `ext` est utilisé côté frontend pour décider si la photo est
affichable nativement dans le navigateur (voir plus bas).

### `GET /api/tags?q=...`

Autocomplétion. `q` vide → jusqu'à 1000 tags (triés) ; `q` renseigné →
`LIKE '%q%'`, jusqu'à 50 résultats. **Filtre explicitement sur les tags
encore attachés à au moins une photo** (`JOIN photo_tags`) — les tags
orphelins (retirés de toutes les photos après un retag, mais dont la ligne
`tags` persiste en base) sont exclus de l'affichage. Le nettoyage réel de
ces lignes orphelines se fait côté indexeur (`db.cleanup_orphan_tags()`),
ce filtre est une deuxième protection côté affichage, indépendante.

### `GET /api/thumb/{photo_id}`

Sert le fichier miniature (`FileResponse`, `image/jpeg`) depuis
`thumbnail_dir`. 404 si la photo n'a pas de `thumb_path` ou si le fichier
est absent du disque (ex: pas encore synchronisé).

### `GET /api/photo/{photo_id}`

Détail complet pour la visionneuse : tous les champs de `row_to_dict()`
**plus** `tags` (liste de strings, via jointure `photo_tags`/`tags`).

### `GET /api/status`

```json
{
  "last_scan": { /* dernière ligne de scan_log, ou null */ },
  "total_photos": 89377,
  "total_tags": 987
}
```

### `POST /api/trigger-scan`

Proxy vers `indexer_trigger_url` (config) `/trigger-scan`. Transmet
simplement la réponse de l'indexeur. 400 si `indexer_trigger_url` n'est pas
configuré, 502 si l'indexeur est injoignable.

## `query_builder.py` — logique de recherche

Fonction unique `build_search_query(...)`, **pure** (pas d'accès DB),
retourne `(sql, params_page, count_sql, count_params)`. Testable en
isolation sans base ni serveur :
```python
sql, params, count_sql, count_params = query_builder.build_search_query(
    keywords=["plage"], keyword_mode="or", date_from="2023-01-01"
)
```

Modèle de combinaison : **(mots-clés en ET/OU) ET (dates) ET (filename) ET
(title) ET (caption)**. Le paramètre `keyword_mode` n'affecte QUE la
sous-requête des mots-clés — tous les autres filtres sont systématiquement
combinés en ET entre eux et avec le résultat des mots-clés, quel que soit
`keyword_mode`.

Détail de la sous-requête mots-clés :
- **`or`** : `JOIN` sur un `SELECT DISTINCT photo_id ... WHERE tag IN (...)`
  — au moins un des tags demandés.
- **`and`** : même structure mais avec `GROUP BY photo_id HAVING
  COUNT(DISTINCT tag_id) = <nombre de mots-clés demandés>` — la photo doit
  avoir **tous** les tags (technique classique pour un ET sur une table de
  jointure many-to-many en SQL standard, sans `INTERSECT` répété).

Tri fixe : `ORDER BY date_taken DESC NULLS LAST, relpath DESC` (photos
récentes en premier, sans date en dernier, second critère pour un ordre
stable face aux photos de même date/heure — rafales).

Recherche textuelle (`filename`/`title`/`caption`) : `LIKE '%valeur%'` avec
échappement manuel de `%` et `_` (`ESCAPE '\\'`) pour éviter qu'un nom de
fichier contenant ces caractères ne casse le filtre.

## Frontend — architecture

Pas de framework, pas de bundler — un seul `<script src="app.js">`, état
global minimal dans l'objet `state` (`keywords`, `page`, `pageSize`).

Flux de recherche :
1. Chaque changement de filtre déclenche `runSearch(1)` (retour à la page
   1) au clic sur "Rechercher", ou `runSearch(page)` depuis la pagination.
2. `runSearch()` lit tous les champs du DOM, construit une
   `URLSearchParams`, `fetch('/api/search?...')`, puis `renderResults()`.
3. `renderResults()` reconstruit entièrement la grille (`innerHTML = ""`
   puis re-création) — pas de diffing, volontairement simple vu le volume
   de résultats par page (≤ `page_size_max`).

Chips de mots-clés : `state.keywords` est un tableau de strings, indépendant
du DOM. `renderChips()` régénère l'affichage à chaque ajout/suppression.
`<input list="tag-list">` (HTML natif) fournit l'autocomplétion via
`loadTagSuggestions(q)`, appelée sur l'event `input`. ⚠️ Piège déjà
rencontré : sélectionner une suggestion déclenche aussi l'event `input`
avec la valeur choisie, ce qui **rétrécit** la `<datalist>` à cette seule
valeur — `addKeywordFromInput()` et `resetFilters()` appellent donc
explicitement `loadTagSuggestions("")` après coup pour la faire revenir à
la liste complète.

## Visionneuse plein écran (lightbox)

Une seule `<div id="lightbox">`, jamais recréée, affichée/masquée via une
classe `.hidden` (`display: none !important` — définie une seule fois,
générique, dans `style.css`; ne pas la redéfinir seulement en combinaison
avec une autre classe, sinon elle n'a d'effet que sur cet élément précis).

`openLightbox(photoId)` :
1. Reset immédiat de l'état visuel (image vidée, message "non affichable"
   masqué, panneau info masqué) — **avant** le `fetch`, pour éviter
   d'afficher brièvement le contenu de la photo précédente.
2. `fetch('/api/photo/{id}')`, puis selon `p.ext` :
   - dans `DISPLAYABLE_EXTENSIONS` (`jpg`,`jpeg`,`png`,`gif`,`webp`) →
     `<img src="{photo_url}">`, redimensionnée en CSS
     (`max-width/max-height: 100%; object-fit: contain`) — **le fichier
     original est chargé tel quel**, pas de fichier intermédiaire généré.
   - sinon (RAW) → message explicatif + lien de téléchargement vers
     `photo_url`. Décision volontaire : pas de génération de preview côté
     indexeur ni à la demande côté webapp (voir
     [Ce que le webapp ne fait pas](#ce-que-le-webapp-ne-fait-pas)).
3. Panneau info : rempli à partir de `FIELD_LABELS` (filename, date, title,
   caption) + liste de tags en pills.

Fermeture : bouton dédié, touche `Échap` (listener global sur
`document`), ou clic sur l'overlay lui-même (`e.target.id === "lightbox"`
— distingue un clic sur le fond d'un clic sur l'image/panneau, qui sont
des éléments enfants donc `e.target` différent).

## Ce que le webapp ne fait PAS

Décisions explicites, à ne pas réintroduire sans y repenser :
- **Pas de génération d'image à la volée** (preview, redimensionnement).
  Cause déjà tranchée dans une itération précédente du projet : ça
  nécessiterait `exiftool`+Pillow côté webapp (actuellement pas un
  prérequis, voir `README.md` racine), casserait le principe read-only
  (écriture d'un cache), et poserait des problèmes de concurrence.
- **Pas d'écriture en base.** Toute tentative d'ajouter une fonctionnalité
  d'édition (retag depuis l'interface, par ex.) doit passer par l'indexeur
  (source de vérité) et une resynchronisation, pas par une écriture directe
  ici.
- **Pas d'authentification.** Pensé pour du LAN de confiance.

## Points d'extension courants

- **Ajouter un critère de recherche** : ajouter le paramètre à
  `query_builder.build_search_query()` (avec son `where.append(...)`),
  l'exposer en paramètre `Query(...)` dans `app.search()`, l'ajouter au
  formulaire (`index.html`) et à `runSearch()`/`resetFilters()`
  (`app.js`).
- **Changer le tri** : une seule ligne dans `query_builder.py` (`ORDER
  BY ...`) — pas encore exposé comme option utilisateur, à faire si besoin
  (nouveau paramètre `sort` dans `/api/search` + sélecteur dans l'UI).
- **Changer la pagination** : `page_size_default`/`page_size_max` dans
  `config.yaml` ; la logique de rendu des boutons de page est dans
  `renderPagination()` (fenêtre de ±3 pages autour de la page courante).

## Tests manuels / debug

```bash
# Tester query_builder.py en isolation (aucune dépendance DB/serveur)
python3 -c "
import query_builder
sql, params, count_sql, count_params = query_builder.build_search_query(
    keywords=['plage','montagne'], keyword_mode='and', title='soleil'
)
print(sql); print(params)
"

# Lancer le serveur en local pour test manuel
PHOTOLIB_WEB_CONFIG=./config.yaml uvicorn app:app --reload --port 8800

# Tester les endpoints sans lancer de vrai serveur (in-process, pratique en CI)
python3 -c "
import os
os.environ['PHOTOLIB_WEB_CONFIG'] = './config.yaml'
from fastapi.testclient import TestClient
import app
client = TestClient(app.app)
print(client.get('/api/search?page_size=1').json())
"
```
