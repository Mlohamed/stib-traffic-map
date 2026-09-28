# STIB TRAFFIC MAP — P0 Métro (démo locale)

**Carte animée du métro bruxellois sur 24 h** — mercredi type, horaires théoriques,
reconstruite depuis les données ouvertes STIB-MIVB (GTFS, CC BY 4.0).
Reproduction du format « carte qui vit » (réf. `magrinj/france-rail-traffic`).

## Ouvrir la démo (zéro installation)

Double-clic sur **`STIBMAP_Metro_v1.0_local.html`** (3,5 Mo, autonome — marche hors
ligne, aucun serveur, aucune clé API).

| Contrôle | Action |
|---|---|
| ▶ / Espace | lecture / pause |
| Timeline | navigation 00:00 → 25:00 (le passage de minuit est géré) |
| ×60 / ×300 / ×1200 | vitesse de simulation |
| Clic sur une ligne (légende) | **zoom cinématique** sur la ligne (re-clic = retour réseau) |
| Molette / glisser | zoom / pan manuels |

## Chiffres de la journée embarquée (mercredi 07/10/2026)

| Métrique | Valeur |
|---|---|
| Courses de métro | **1 383** (lignes 1 : 333, 2 : 325, 5 : 364, 6 : 361) |
| Pic de véhicules simultanés | **49 à 07:07** |
| Points de trajectoire | 249 161 (pas 10 s) |
| Données brutes embarquées | 2,50 Mo (binaire custom, header self-describing) |
| Validation | `pipeline/validate_p0.py` → CONFORME (24 contrôles) |
| Profil horaire vérifié | 1 véhicule à 05:00 → 47 au pic → 46 au pic du soir → 18 après minuit |

## Structure du repo

```
├── STIBMAP_Metro_v1.0_local.html   ← LA DÉMO (double-clic)
├── clip_stibmap_p0.mp4             ← clip 30 s de la journée complète (rendu à la demande)
├── SPEC_STIBMAP_P0.md              ← spec technique (GO-STIBMAP-0)
├── PLAN_STIB_TRAFFIC_MAP.md        ← plan décisionnel + suivi des GO
├── data/be-stib-gtfs.zip, data/gtfs/   ← GTFS STIB (miroir data.gtfs.be, quotidien)
├── pipeline/                       ← build, validation, rendu clip (Python stdlib, 0 dépendance)
├── app/                            ← template + assemblage + sondes de test (jsdom)
└── data_out/                       ← binaires générés (metro.bin, trips.json, stats.json, lines.geojson)
```

## Chaîne de vérification (tout est exécutable)

```bash
python pipeline/build_p0.py        # GTFS -> binaires (17 s)
python pipeline/validate_p0.py     # 24 contrôles -> CONFORME
python app/build_standalone.py     # injecte les données dans le HTML
node app/verifier_page.js          # sonde DOM jsdom -> CONFORME
python pipeline/render_clip.py     # clip MP4 (optionnel)
```

## Phases suivantes (GO gating)

- **P1** : + tram (18 lignes) — le réseau devient impressionnant.
- **P2** : + bus + Noctis (70 lignes), 3 journées types (mercredi/samedi/dimanche), ~22-34 Mo.
- **P3** : journée « observée » (MobilityTwin.Brussels, 2,97 M positions réelles), perturbations.
- **Publication** (GO-STIBMAP-2, gating Mohamed) : repo public + site + clip.

---
*Données : STIB-MIVB, CC BY 4.0 (GTFS via data.gtfs.be) · Démo locale — jamais publiée sans GO.*
