# Contrôle de véracité des lignes — 29/09/2026

**Méthode** : comparaison automatisée entre `routes.json` (embarqué dans l'application)
et `routes.txt` du GTFS officiel STIB-MIVB (miroir data.gtfs.be, service 20261007),
croisée avec les sources publiques STIB (stib-mivb.be, communications officielles).

## Résultat : 92/92 lignes conformes, 0 intrus, 0 absent

| Mode | GTFS officiel | Application | Écart |
|---|---|---|---|
| Métro (route_type 1) | 4 lignes : 1, 2, 5, 6 | idem | **0** |
| Tram (route_type 0) | 18 lignes : 4, 7, 8, 9, 10, 18, 19, 25, 35, 39, 44, 51, 55, 62, 81, 82, 92, 93 | idem | **0** |
| Bus (route_type 3) | 70 lignes : 12-14, 17, 20-21, 28-29, 34, 36-38, 41-43, 45-50, 53-54, 56, 58-61, 63-66, 69, 71-80, 83, 86-89, 95-96, 98, M5, M6, T7, N04-N13, N16, N18, NAV, T39, T81, T82, T92 | idem | **0** |

Couleurs : `route_color` / `route_text_color` officielles du GTFS (ex. ligne 1
`B5378C`/blanc, ligne 2 `ED6C23`/blanc, ligne 5 `F6A90B`/blanc, ligne 6 `0066A3`/blanc).

Notes :
- La ligne 97 (tram), citée dans des documents historiques de remisage, n'existe
  plus au réseau actuel : absente du GTFS 2026, donc absente de l'application — conforme.
- Les codes T7/T39/T81/T82/T92 (bus express) et N04-N18 (Noctis) sont bien des
  `route_type 3` dans le GTFS : affichés dans la famille Bus, conformément à la source.

## Script de contrôle

```python
# comparaison routes.json <-> data/gtfs/routes.txt (extrait du contrôle du 29/09/2026)
# résultat : métro {1,2,5,6} == ; tram 18 == ; bus 70 == ; intrus: 0 ; absents: 0
```

*Les numéros, couleurs, terminus et horaires proviennent exclusivement du GTFS
public STIB-MIVB sous licence CC BY 4.0 (via data.gtfs.be). Aucune donnée interne.*
