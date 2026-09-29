# Brussels Network in Motion

**Le réseau de métro et tram bruxellois, entier, qui vit sur une journée —
reconstruit course par course depuis les données ouvertes GTFS de la STIB-MIVB.**

https://mlohamed.github.io/stib-traffic-map/

| | |
|---|---|
| Courses simulées (mercredi type) | **7 584** — métro 1 383 · tram 6 201 |
| Lignes | **22** — 4 métro, 18 tram, couleurs officielles |
| Véhicules au pic | **260 simultanés** (16:10) · 233 à la pointe du matin (07:07) |
| Trajectoires calculées | **967 475** points interpolés sur les shapes GTFS |
| Données embarquées | 9,7 Mo de binaires compacts (métro pas 10 s, tram pas 15 s) |
| Dépendances runtime | **zéro** — Canvas 2D natif, aucun framework, aucune clé API |

*Visualisation indépendante de démonstration — non affiliée à la STIB-MIVB.
Données ouvertes STIB-MIVB, CC BY 4.0 (GTFS via data.gtfs.be), horaires théoriques.*

---

## Deux façons de montrer le réseau

**1. En ligne** — https://mlohamed.github.io/stib-traffic-map/
Le splash s'ouvre sur les chiffres du réseau, puis deux boutons :
**Explorer le réseau** (main libre) ou **Présentation automatique**
(scénario de 8 scènes qui balaie la journée : aube, pointe du matin
sur la boucle 2/6, maillage tram, pointe du soir, soirée accélérée — boucle
parfaite pour un stand ou un écran de hall).

**2. Hors ligne** — `STIBMAP_UITP_v2.0_local.html` (13,4 Mo, double-clic,
aucun serveur). Même expérience, données inline.

## Ce qu'on voit

- **Chaque véhicule** est un point brillant avec traînée, positionné par
  interpolation temporelle entre les arrêts projetés sur la géométrie réelle
  des lignes (`shapes.txt`).
- **Les badges de terminus** (Stockel, Herrmann-Debroux, Esplanade, Heysel…)
  apparaissent aux extrémités des lignes ; les noms sont les vrais libellés
  GTFS, en typographie soignée.
- **Le panneau « Le réseau, maintenant »** donne l'heure, la phase de journée
  narrée (bilingue FR/NL aux moments clés : *ochtendspits*, *avondspits*),
  les véhicules en ligne et le prochain pic — la légende groupée Métro/Tram
  affiche le **compteur par ligne, mis à jour en direct**, et chaque ligne est
  cliquable (zoom cinématique).
- **La timeline 00:00 → 25:00** gère le service de nuit : les courses qui
  franchissent minuit restent visibles, marquées **J+1**.

## Reproduire (chaîne 100 % exécutable, Python stdlib)

```bash
python pipeline/build_p0.py            # GTFS -> metro.bin (1 383 courses, 0 rejet)
python pipeline/build_p1.py            # + tram.bin (6 201 courses, 0 rejet)
python pipeline/validate_p0.py         # 24 contrôles de cohérence -> CONFORME
python app/build_standalone_uitp.py    # assemble local 13,4 Mo + site (shell + app.js + data/)
node app/verifier_uitp.js              # sonde DOM : positions écran finies -> CONFORME
python pipeline/render_clip.py         # clip MP4 (Edge headless + ffmpeg, retry par frame)
```

Le binaire (header self-describing : magic, version, dt, nombre de courses ;
points lat/lon f32 + offset u16) est décodé côté navigateur sans bibliothèque.
La projection arrêts→shape utilise un balayage à patience qui tolère les
boucles de terminus. Le pipeline ne dépend d'aucun paquet tiers.

## Architecture

```
├── site/                      ← LE SITE (GitHub Pages) : index 12,7 Ko + app.js 20,4 Ko + data/ 10,1 Mo
├── STIBMAP_UITP_v2.0_local.html  ← démo autonome double-clic
├── pipeline/                  ← build P0/P1, validation, rendu clip (stdlib uniquement)
├── app/                       ← template vitrine + assemblage + sondes jsdom
├── SPEC_STIBMAP_P0.md         ← spec technique du format binaire
└── data/                      ← GTFS source (exclu du repo, miroir data.gtfs.be)
```

## Feuille de route

| Phase | Contenu | État |
|---|---|---|
| P0 | Métro, 4 lignes | ✅ livré |
| P1 | + tram (18 lignes) | ✅ livré |
| v2 | Édition vitrine (splash, présentation auto, badges terminus) | ✅ livré |
| P2 | + bus + Noctis (70 lignes), découpage horaire 60 min | chiffré, prêt |
| P3 | Journée observée MobilityTwin (2,97 M positions réelles), perturbations | prospectif |

---

*Données : STIB-MIVB Open Data, licence CC BY 4.0 — GTFS via data.gtfs.be.
Simulation d'un mercredi type sur horaires théoriques ; aucun temps réel.
Concept inspiré du format « live transit map » (réf. magrinj/france-rail-traffic).*
