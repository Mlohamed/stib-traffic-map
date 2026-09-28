#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STIB TRAFFIC MAP — validation P0 (critères spec §7).
Vérifie metro.bin (structure + bornes), trips.json, stats.json, lines.geojson.
Exit 0 = conforme, exit 1 = échec (liste des échecs affichée).
"""
import json
import math
import os
import struct
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data_out")

MAGIC = b"STIBP0\0\0"
POINT_FMT = struct.Struct("<2fH")
TRIP_HDR_FMT = struct.Struct("<BIH")
BBOX = (50.76, 4.24, 50.92, 4.49)
DUREE_MIN_S = 200  # 221 s mesuré : courses partielles réelles (4 arrêts, garage/retour court)
DUREE_MAX_S = 44 * 60  # 42 min mesuré + marge
MIN_TRIPS = 1380       # 1 383 attendus (marge 3)

fails = []
warns = []


def check(label, cond, detail=""):
    print(f"  {'OK ' if cond else 'FAIL'}  {label}" + (f" — {detail}" if detail else ""))
    if not cond:
        fails.append(label)


print("== Validation P0 ==")

# --- fichiers présents
for fn in ["metro.bin", "trips.json", "stats.json", "lines.geojson"]:
    p = os.path.join(OUT, fn)
    check(f"présent: {fn}", os.path.isfile(p), f"{os.path.getsize(p)/1e6:.2f} Mo" if os.path.isfile(p) else "")

bin_path = os.path.join(OUT, "metro.bin")
if fails:
    print("Fichiers manquants -> arrêt.")
    sys.exit(1)

# --- metro.bin : structure intégrale
data = open(bin_path, "rb").read()
check("magic", data[:8] == MAGIC, repr(data[:8]))
version, dt, n_trips_hdr = struct.unpack_from("<HHI", data, 8)
check("version = 1", version == 1)
check("dt = 10 s", dt == 10, f"dt={dt}")

pos = 16
n_trips = 0
n_points_total = 0
bad_t = bad_bbox = bad_dur = 0
min_lat = max_lat = min_lon = max_lon = None
durations = []
route_refs = set()
while pos < len(data):
    ref, t0, n_points = TRIP_HDR_FMT.unpack_from(data, pos)
    pos += TRIP_HDR_FMT.size
    last_off = -1
    for k in range(n_points):
        la, lo, off = POINT_FMT.unpack_from(data, pos)
        pos += POINT_FMT.size
        if off <= last_off:
            bad_t += 1
        last_off = off
        if math.isnan(la) or math.isnan(lo):
            bad_bbox += 1
            continue
        min_lat = la if min_lat is None else min(min_lat, la)
        max_lat = la if max_lat is None else max(max_lat, la)
        min_lon = lo if min_lon is None else min(min_lon, lo)
        max_lon = lo if max_lon is None else max(max_lon, lo)
        if not (BBOX[0] - 0.02 <= la <= BBOX[2] + 0.02 and BBOX[1] - 0.02 <= lo <= BBOX[3] + 0.02):
            bad_bbox += 1
    route_refs.add(ref)
    durations.append(off)
    n_points_total += n_points
    n_trips += 1

check("n_trips cohérent header", n_trips == n_trips_hdr, f"{n_trips} vs {n_trips_hdr}")
check(f"courses >= {MIN_TRIPS}", n_trips >= MIN_TRIPS, f"{n_trips}")
check("consumé jusqu'au dernier octet", pos == len(data), f"{pos}/{len(data)}")
check("offsets t croissants dans chaque course", bad_t == 0, f"{bad_t} anomalies")
check("positions dans le bbox Bruxelles, zéro NaN", bad_bbox == 0, f"{bad_bbox} anomalies")
check(f"durées dans [{DUREE_MIN_S//60};{DUREE_MAX_S//60}] min",
      all(DUREE_MIN_S <= d <= DUREE_MAX_S for d in durations),
      f"min {min(durations)//60} / max {max(durations)//60}")
check("route refs valides (0-3)", all(0 <= r <= 3 for r in route_refs), str(sorted(route_refs)))

# --- trips.json
trips = json.load(open(os.path.join(OUT, "trips.json"), encoding="utf-8"))
check("trips.json : nb courses = binaire", len(trips["trips"]) == n_trips, f"{len(trips['trips'])}")
check("trips.json : 4 lignes", len(trips["routes"]) == 4, str([r["line"] for r in trips["routes"]]))
check("trips.json : couleurs 6 hex", all(len(r["color"]) == 6 for r in trips["routes"]))

# --- stats.json
stats = json.load(open(os.path.join(OUT, "stats.json"), encoding="utf-8"))
check("stats : courses = binaire", stats["trips"] == n_trips)
check("stats : rejets = 0", sum(stats["rejected"].values()) == 0, str(stats["rejected"]))
peak = stats["peak_simultaneous"]
h = int(stats["peak_time"][:2])
check("pic heure de pointe > heure creuse (plausibilité)", peak >= 40 and 6 <= h <= 9,
      f"pic {peak} à {stats['peak_time']}")
hourly = stats["hourly_max"]
check("profil horaire : max(6h-9h) > max(11h-14h)", max(hourly[6:9]) > max(hourly[11:14] or [0]),
      f"pointe {max(hourly[6:9])} vs milieu {max(hourly[11:14] or [0])}")
check("stats : durée médiane 25-40 min", 25 * 60 <= stats["duration_s"]["median"] <= 40 * 60,
      f"{stats['duration_s']['median']//60} min")

# --- lines.geojson
geo = json.load(open(os.path.join(OUT, "lines.geojson"), encoding="utf-8"))
n_feat = len(geo.get("features", []))
lines_in_geo = {f["properties"]["line"] for f in geo.get("features", [])}
check("lines.geojson : >= 6 tracés (4 lignes, 2 sens)", n_feat >= 6, f"{n_feat} features")
check("lines.geojson : 4 lignes distinctes", lines_in_geo == {"1", "2", "5", "6"}, str(sorted(lines_in_geo)))
coords_ok = all(len(f["geometry"]["coordinates"]) > 20 for f in geo["features"])
check("lines.geojson : tracés non dégénérés", coords_ok)

print()
if fails:
    print(f"ÉCHEC ({len(fails)}): " + "; ".join(fails))
    sys.exit(1)
print(f"VALIDATION P0 CONFORME — {n_trips} courses, {n_points_total:,} points, "
      f"pic {peak} véhicules à {stats['peak_time']}, "
      f"bbox lat[{min_lat:.3f};{max_lat:.3f}] lon[{min_lon:.3f};{max_lon:.3f}]")
sys.exit(0)
