#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STIB TRAFFIC MAP — table des arrêts par ligne (additive, n'altère ni les .bin ni routes/lines).
Sortie : data_out/stops.json
  { "stops": [[nom_fr, nom_nl, lat, lon], ...],
    "by_line": { "<numéro de ligne>": [index d'arrêt, ...] } }
Sert au client pour : « prochain arrêt » du véhicule suivi, pulse des stations de métro.
Usage : python pipeline/build_stops.py [--gtfs data/gtfs] [--out data_out]
"""
import argparse
import csv
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def rows(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        yield from csv.DictReader(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gtfs", default=os.path.join(ROOT, "data", "gtfs"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data_out"))
    a = ap.parse_args()

    lignes = {r["line"] for r in json.load(open(os.path.join(a.out, "routes.json"), encoding="utf-8"))["routes"]}
    route_line = {r["route_id"]: r["route_short_name"] for r in rows(os.path.join(a.gtfs, "routes.txt"))
                  if r["route_short_name"] in lignes}
    trip_line = {r["trip_id"]: route_line[r["route_id"]] for r in rows(os.path.join(a.gtfs, "trips.txt"))
                 if r["route_id"] in route_line}

    nl = {}
    for r in rows(os.path.join(a.gtfs, "translations.txt")):
        if r["table_name"] == "stops" and r["field_name"] == "stop_name" and r["language"] == "nl":
            nl[r["field_value"]] = r["translation"]

    stops = {r["stop_id"]: (r["stop_name"], float(r["stop_lat"]), float(r["stop_lon"]))
             for r in rows(os.path.join(a.gtfs, "stops.txt"))}

    servis = {}  # ligne -> set(stop_id)
    with open(os.path.join(a.gtfs, "stop_times.txt"), encoding="utf-8-sig", newline="") as f:
        rd = csv.reader(f)
        h = next(rd)
        it, isid = h.index("trip_id"), h.index("stop_id")
        for row in rd:
            ln = trip_line.get(row[it])
            if ln is not None:
                servis.setdefault(ln, set()).add(row[isid])

    index, liste = {}, []
    by_line = {}
    for ln in sorted(servis, key=lambda s: (len(s), s)):
        ids = []
        for sid in sorted(servis[ln]):
            if sid not in stops:
                continue
            if sid not in index:
                nom, la, lo = stops[sid]
                index[sid] = len(liste)
                n_nl = nl.get(nom, nom)
                liste.append([nom, "" if n_nl == nom else n_nl, round(la, 6), round(lo, 6)])
            ids.append(index[sid])
        by_line[ln] = ids

    manquantes = sorted(lignes - set(by_line))
    out = os.path.join(a.out, "stops.json")
    json.dump({"stops": liste, "by_line": by_line}, open(out, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    print(f"stops.json : {len(liste)} arrêts, {len(by_line)}/{len(lignes)} lignes "
          f"({os.path.getsize(out)/1e3:.0f} Ko)" + (f" — sans arrêts : {manquantes}" if manquantes else ""))


if __name__ == "__main__":
    main()
