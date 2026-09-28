# SPEC TECHNIQUE P0 — STIB TRAFFIC MAP (GO-STIBMAP-0, 28/09/2026)

Livrable de cette carte : **la spec, zéro code livré**. Le build est GO-STIBMAP-1,
la publication GO-STIBMAP-2. Toutes les valeurs ci-dessous sont **mesurées sur le
GTFS réellement présent** dans `data/gtfs/` (miroir `data.gtfs.be/stib/gtfs/be-stib-gtfs.zip`,
contrôlé 28/09), pas estimées.

---

## 1. Périmètre P0

**Métro uniquement** (routes GTFS `route_type=1` : lignes 1, 2, 5, 6), **une seule
journée type : un mercredi**, horaires **théoriques** (GTFS), animation 00:00 → 24:00
avec débordement après minuit. Démo **locale** à Mohamed (double-clic), aucune mise
en ligne. Référence visuelle : `magrinj/france-rail-traffic` (fond sombre, points
mobiles avec traînée, scrubber, compteurs).

Hors périmètre P0 (verrouillé aux phases suivantes) : tram P1, bus + Noctis P2,
journée « observée » MobilityTwin P3, temps réel P3, GitHub Actions / site public /
clip = GO-STIBMAP-2 uniquement.

## 2. Données source — chiffres vérifiés (28/09/2026)

| Élément | Valeur mesurée |
|---|---|
| Fichier | `data/gtfs/` (extrait de `be-stib-gtfs.zip`, 16,6 Mo) |
| Routes | 92 (type 1 : 4 métro, type 0 : 18 tram, type 3 : 70 bus) — **92/92 avec couleur officielle** |
| Courses totales (fenêtre ~28 j) | 94 110 trips, 371 service_id |
| Courses réseau un mercredi | **23 422** (samedi : 13 074, dimanche : 11 392) |
| **Courses MÉTRO un mercredi** | **1 383** (ligne 1 : 333, 2 : 325, 5 : 364, 6 : 361) |
| Durée course métro | médiane 31 min, min 4, max 43 |
| Shapes | 731 tracés, 263 162 points, **`shape_dist_traveled` présent** → interpolation directe, **pas de map-matching OSM** (le plus dur du projet français disparaît) |
| Arrêts | 2 800 |
| Colonnes clés | `routes(route_color, route_text_color)` ; `stop_times` sans `shape_dist_traveled` → projection arrêts→shape à calculer (§4.3) |
| Heures ≥ 24:00 (tous modes) | 64 891 lignes `stop_times` → gestion obligatoire du passage de minuit (§4.5) |
| Licence | CC BY 4.0 (attribution STIB-MIVB à afficher dans l'UI dès P0) |
| Rafraîchissement miroir | quotidien ; GTFS fenêtre glissante ~28 j → rebuild nocturne obligatoire pour rester valide (P2+/GO-2) |

## 3. Structure repo (créée à GO-1)

```
STIB_TRAFFIC_MAP/
├── PLAN_STIB_TRAFFIC_MAP.md      (existant — décision GO)
├── SPEC_STIBMAP_P0.md            (ce document)
├── data/
│   ├── be-stib-gtfs.zip          (existant)
│   └── gtfs/                     (existant — extrait)
├── pipeline/                     (Python 3 stdlib uniquement : csv, struct, json, zipfile — zéro pip install)
│   ├── build_p0.py               (GTFS → data_out/*, < 60 s)
│   └── validate_p0.py            (contrôles §7, exit 1 si échec)
├── data_out/                     (généré + commité, ~3,2 Mo)
│   ├── metro.bin                 (format §5)
│   ├── trips.json                (index lisible des courses : route, couleur, headsign, t0, t1, n_points)
│   ├── lines.geojson             (tracés des 4 lignes + couleurs officielles, pour le fond de carte)
│   └── stats.json                (chiffres affichés : courses, pic véhicules simultanés, longueurs)
└── app/
    ├── index.html                (démo standalone : HTML+CSS+JS vanilla, données inline base64)
    └── build_standalone.py       (injecte data_out en base64 dans index.html)
```

Conformité règles du dossier `13_Projets _SaaS` : **un HTML standalone ouvrable par
double-clic, zéro serveur, zéro build JS, zéro CDN, zéro dépendance npm**. C'est la
raison du choix de rendu ci-dessous.

## 4. Pipeline `build_p0.py` — algorithme

### 4.1 Sélection du service (le piège classique GTFS)
Jour cible paramétrable (`--date 20260930`, défaut : prochain mercredi). Service actif :
1. `calendar_dates.txt` d'abord : si exception pour la date → `exception_type=1` actif,
   `=2` retiré, quel que soit `calendar.txt` ;
2. sinon `calendar.txt` : `start_date ≤ date ≤ end_date` ET flag du jour de semaine à 1.
Vérifié : 99 services actifs mercredi 30/09 → 1 383 courses métro.

### 4.2 Sélection courses
`routes.route_type == "1"` → 4 `route_id` → trips dont `service_id` actif et
`shape_id` présent dans `shapes.txt` (course sans shape = exclue + comptée dans le
rapport de validation).

### 4.3 Projection des arrêts sur la shape
`stop_times` STIB ne porte pas `shape_dist_traveled`. Pour chaque course :
parcourir les arrêts dans l'ordre de `stop_sequence` et chercher le point de shape le
plus proche par **balayage glissant** (fenêtre locale croissante le long de la shape —
jamais de retour arrière) → distance du stop = `shape_dist_traveled` du point retenu.
Contrôle : distances strictement croissantes ; toute inversion → course rejetée et
loguée. Coût O(points_shape + n_stops) par course.

### 4.4 Profil horaire de la course
- `t_dep[i]` = `departure_time` du stop i, `t_arr[i]` = `arrival_time` (parse `H:MM:SS`,
  H peut être ≥ 24) ;
- segment i→i+1 : vitesse constante sur la distance `d[i+1] − d[i]` ;
- aux arrêts : dwelling réel du GTFS (`t_arr − t_dep`, typiquement 15-30 s) — le véhicule
  **marque un vrai arrêt visible**, comme le métro français ;
- bornes : position = départ du 1er stop à `t_dep[0]`, disparition à `t_arr[-1]`.

### 4.5 Passage de minuit
Temps absolu en secondes depuis 00:00, heures ≥ 24 conservées telles quelles (t >
86 400 = après minuit). Timeline de l'UI : 00:00 → 25:00 avec graduations 0-24 h ;
les courses nocturnes restent visibles à droite de minuit. (Règle P2 à retenir dès
maintenant pour bus/Noctis : inclure aussi les services de la **veille** — courses
Noctis qui commencent avant minuit.)

### 4.6 Échantillonnage
Δt = **10 s** du début à la fin de chaque course, interpolation **en distance cumulée**
(along-track) puis conversion en lat/lon par interpolation linéaire entre points de
shape — pas d'interpolation directe lat/lon (évite de couper les courbes).
Positions aux arrêts dupliquées pendant le dwell (le point « se pose »).

### 4.7 Sorties
`metro.bin` (§5), `trips.json` (index), `lines.geojson` (un LineString par sens de
ligne, propriétés : `route_short_name`, `route_color`), `stats.json` :
nb courses, pic de véhicules simultanés (comptage par minute), longueur réseau,
duration min/max — ces deux derniers chiffres affichés dans l'UI avec l'attribution.

## 5. Format binaire `metro.bin` (versionné)

```
Header (16 octets) :
  0-7   magic  "STIBP0\0\0"          (8 o)
  8-9   version u16 = 1
  10-11 dt      u16 = 10             (pas d'échantillonnage, s)
  12-15 n_trips u32                  (little-endian partout)

Par course, séquentiel :
  route_ref u8                       (index dans la table routes de trips.json — 4 lignes)
  t0        u32                      (départ, s depuis 00:00 ; peut dépasser 86 400)
  n_points  u16
  points    n_points × 12 o : lat f32le | lon f32le | t u16 (offset depuis t0, s)
```

- Taille P0 : 1 383 × (8 + 186×12) ≈ **3,1 Mo** → fichier unique, pas de découpage.
- t en u16 : course max 43 min = 2 580 s < 65 535 ✓. f32 lat/lon : précision ≈ 6 cm à
  Bruxelles, très supérieure au besoin d'affichage.
- **Découpage horaire (règle écrite dès P0, appliquée à P1/P2)** : au-delà de ~5 Mo,
  tranches de **60 min avec overlap 600 s** (`slice_00.bin`…), header identique, toute
  course chevauchant la tranche est incluse des deux côtés ; le client charge 2
  tranches au scrub et déduplique par position dans `trips.json`.
- Décodage JS : `DataView`, ~30 lignes, zéro librairie.

## 6. Frontend `app/index.html`

| Choix | Décision | Raison |
|---|---|---|
| Rendu | **Canvas 2D natif** (projection Web Mercator maison, ~20 lignes) | 4 lignes, ~100-250 véhicules simultanés en pointe, 186 pts/course → trivial à 60 fps ; zéro MapLibre/deck.gl/npm = conforme standalone/offline. deck.gl TripsLayer ne devient pertinent qu'à P2 (~23 000 courses) — décision réévaluée à P1. |
| Fond de carte | Fond sombre uni + tracés `lines.geojson` dessinés (couleurs officielles STIB) | Zéro tuile externe, zéro clé, marche hors ligne ; grammaire visuelle identique au projet français |
| Traînée | N derniers points de chaque véhicule (N = 30-60 s d'historique), trait dégradé en alpha | Même effet que la France (où la traîne = durée en secondes) ; les métros laissent mécaniquement une traîne plus longue que les bus futurs |
| Contrôles | Play/pause, vitesse ×60/×300/×1200, scrubber 00:00→25:00, horloge HH:MM, compteurs véhicules par mode (métro seul en P0), légende 4 lignes, attribution « Données : STIB-MIVB, CC BY 4.0 » | UI en français (règle dossier) |
| Données | `data_out/*` injectées en **base64 inline** dans le HTML par `build_standalone.py` (~4,2 Mo HTML) | Double-clic sans serveur : `fetch()` impossible en `file://` → inline contourne CORS proprement. La version publiée (GO-2) servira les binaires séparés (cache navigateur). |

## 7. Critères de validation P0 (avant toute demande GO-2)

1. `build_p0.py` < 60 s ; `validate_p0.py` OK : ≥ 1 380 courses, distances croissantes,
   lat ∈ [50,76 ; 50,92], lon ∈ [4,24 ; 4,49], durée ∈ [3,5 ; 44] min (le GTFS contient
   4 courses partielles réelles de ~3,7 min — garage/retour court, vérifiées 28/09),
   zéro NaN ;
2. `index.html` **ouvré par double-clic** : animation fluide (> 55 fps), scrubber et
   vitesse fonctionnels, 4 lignes aux couleurs officielles, véhicules marquant les
   arrêts, passage de minuit correct (fin de service) ;
3. Pic de véhicules simultanés plausible (heure de pointe > heure creuse, contrôlé
   dans `stats.json`) ;
4. Chiffres affichés = chiffres `stats.json` = mesures du 28/09 (§2) ;
5. Démo faite à Mohamed → seulement ensuite GO-STIBMAP-2 (repo public + site + clip).

## 8. Risques P0 et mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| Projection arrêts→shape imprécise (courbes serrées, boucles terminus) | Véhicule qui coupe hors rail | Balayage glissant ordonné + rejet/log des inversions ; contrôle visuel ligne par ligne en démo |
| Courses sans shape ou horaires incohérents | Crash pipeline | Exclusion + comptage obligatoire dans `validate_p0.py` (jamais silencieux) |
| HTML 4,2 Mo inline peu maniable à l'usage | Démo lente à ouvrir | Acceptable en local ; version binaire séparée réservée à la publication |

## 9. Estimation d'effort GO-1 (build P0)

Pipeline Python stdlib + page Canvas 2D : **~600-800 lignes au total**, une session
de build + une passe de validation visuelle. Zéro dépense, zéro clé, zéro
dépendance à installer. Volumes supérieurs déjà chiffrés pour la suite : P2 réseau
complet ≈ 22-34 Mo de binaires (tranches 60 min + overlap), à trancher au build P1.
