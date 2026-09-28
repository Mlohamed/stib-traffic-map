#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STIB TRAFFIC MAP — build P0 (GO-STIBMAP-1)
GTFS STIB -> binaires + index pour la carte animée du MÉTRO (1 journée type).
Spec : ../SPEC_STIBMAP_P0.md (§4 pipeline, §5 format binaire).
Zéro dépendance : Python 3 stdlib uniquement. Cible d'exécution : < 60 s.
"""
import argparse
import bisect
import csv
import json
import math
import os
import struct
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta

try:  # console Windows : forcer l'UTF-8 pour les accents
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_GTFS = os.path.join(ROOT, "data", "gtfs")
DEFAULT_OUT = os.path.join(ROOT, "data_out")

MAGIC = b"STIBP0\0\0"
VERSION = 1
POINT_FMT = struct.Struct("<2fH")     # lat f32 | lon f32 | t u16 (offset depuis t0, s)
TRIP_HDR_FMT = struct.Struct("<BIH")  # route_ref u8 | t0 u32 | n_points u16 (spec §5)
DAY_FIELDS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
R_TERRE = 6371.0088  # km
BBOX = (50.76, 4.24, 50.92, 4.49)  # lat_min, lon_min, lat_max, lon_max (spec §7)
BBOX_MARGE = 0.05
MAX_TRIP_SPAN_S = 65535  # limite du champ u16 (offset t)


# ---------------------------------------------------------------- utilitaires
def parse_gtfs_time(t: str) -> int:
    """'H:MM:SS' (H peut dépasser 24) -> secondes depuis 00:00."""
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def read_rows(path):
    """Lignes d'un CSV GTFS en dicts (utf-8-sig)."""
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            yield row


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_TERRE * math.asin(math.sqrt(a))


def fmt_hms(sec: int) -> str:
    return f"{sec // 3600:02d}:{(sec % 3600) // 60:02d}"


# ---------------------------------------------------------------- chargement
def load_routes(gtfs):
    """Routes métro (route_type=1) triées par numéro -> table de référence."""
    routes = []
    for row in read_rows(os.path.join(gtfs, "routes.txt")):
        if row["route_type"] == "1":
            routes.append({
                "route_id": row["route_id"],
                "line": row["route_short_name"],
                "long_name": row["route_long_name"],
                "color": row["route_color"].lstrip("#").upper(),
                "text_color": row["route_text_color"].lstrip("#").upper(),
            })
    routes.sort(key=lambda r: int(r["line"]))
    for ref, r in enumerate(routes):
        r["ref"] = ref
    return routes


def load_active_services(gtfs, ymd: str):
    """Services actifs à yyyymmdd : exceptions calendar_dates d'abord (spec §4.1),
    puis calendar.txt (fenêtre + jour de semaine)."""
    exceptions = {}
    for row in read_rows(os.path.join(gtfs, "calendar_dates.txt")):
        if row["date"] == ymd:
            exceptions[row["service_id"]] = int(row["exception_type"])
    day = DAY_FIELDS[date(int(ymd[:4]), int(ymd[4:6]), int(ymd[6:])).weekday()]
    active = set()
    for row in read_rows(os.path.join(gtfs, "calendar.txt")):
        if not (row["start_date"] <= ymd <= row["end_date"]):
            continue
        if row[day] == "1":
            active.add(row["service_id"])
    active |= {sid for sid, t in exceptions.items() if t == 1}
    active -= {sid for sid, t in exceptions.items() if t == 2}
    return active


def load_shapes(gtfs):
    """shape_id -> (lats, lons, dists). dist = shape_dist_traveled si monotone,
    sinon cumul haversine (m)."""
    raw = {}
    for row in read_rows(os.path.join(gtfs, "shapes.txt")):
        d = (row.get("shape_dist_traveled") or "").strip()
        raw.setdefault(row["shape_id"], []).append((
            int(row["shape_pt_sequence"]),
            float(row["shape_pt_lat"]),
            float(row["shape_pt_lon"]),
            float(d) if d else None,
        ))
    shapes = {}
    for sid, pts in raw.items():
        pts.sort(key=lambda p: p[0])
        lats = [p[1] for p in pts]
        lons = [p[2] for p in pts]
        dists = None
        if pts[0][3] is not None and all(p[3] is not None for p in pts):
            cand = [p[3] for p in pts]
            if all(cand[i] <= cand[i + 1] for i in range(len(cand) - 1)):
                dists = cand
        if dists is None:  # fallback : cumul haversine
            dists = [0.0]
            for i in range(1, len(pts)):
                dists.append(dists[-1] + haversine_km(lats[i - 1], lons[i - 1], lats[i], lons[i]) * 1000.0)
        shapes[sid] = (lats, lons, dists)
    return shapes


# ------------------------------------------------- projection arrêts -> shape
def project_stop_dists(shape, stops_lat, stops_lon, patience=200):
    """Balayage glissant avec patience (spec §4.3) : distance along-track de chaque
    arrêt. Le premier arrêt est balayé globalement (il peut se situer après une
    boucle de terminus au début de la shape) ; les suivants cherchent l'argmin
    dans une fenêtre bornée [cur, cur+patience] — tolère les boucles sans retour
    arrière. Non décroissant par construction."""
    lats, lons, dists = shape
    n = len(lats)
    out = []
    # arrêt 0 : argmin global
    bd, best = None, 0
    for j in range(n):
        d = (lats[j] - stops_lat[0]) ** 2 + (lons[j] - stops_lon[0]) ** 2
        if bd is None or d < bd:
            bd, best = d, j
    cur = best
    out.append(dists[cur])
    # arrêts suivants : fenêtre bornée
    for k in range(1, len(stops_lat)):
        slat, slon = stops_lat[k], stops_lon[k]
        bd = (lats[cur] - slat) ** 2 + (lons[cur] - slon) ** 2
        best = cur
        jmax = min(n, cur + patience)
        for j in range(cur + 1, jmax):
            d = (lats[j] - slat) ** 2 + (lons[j] - slon) ** 2
            if d < bd:
                bd, best = d, j
        cur = best
        out.append(dists[cur])
    return out


def interp_on(ctrl_t, ctrl_d, t):
    """d(t) par interpolation linéaire sur les points de contrôle de la course."""
    if t <= ctrl_t[0]:
        return ctrl_d[0]
    if t >= ctrl_t[-1]:
        return ctrl_d[-1]
    i = bisect.bisect_right(ctrl_t, t) - 1
    t0, t1 = ctrl_t[i], ctrl_t[i + 1]
    if t1 <= t0:
        return ctrl_d[i]
    w = (t - t0) / (t1 - t0)
    return ctrl_d[i] + w * (ctrl_d[i + 1] - ctrl_d[i])


def dist_to_latlon(shape, d):
    """Distance along-track -> (lat, lon) interpolés entre points de shape."""
    lats, lons, dists = shape
    if d <= dists[0]:
        return lats[0], lons[0]
    if d >= dists[-1]:
        return lats[-1], lons[-1]
    j = bisect.bisect_right(dists, d) - 1
    d0, d1 = dists[j], dists[j + 1]
    if d1 <= d0:
        return lats[j], lons[j]
    w = (d - d0) / (d1 - d0)
    return lats[j] + w * (lats[j + 1] - lats[j]), lons[j] + w * (lons[j + 1] - lons[j])


# ---------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Build P0 STIB Traffic Map (métro)")
    ap.add_argument("--date", default=None, help="jour type yyyymmdd (défaut : dernier mercredi du feed)")
    ap.add_argument("--dt", type=int, default=10, help="pas d'échantillonnage en secondes (défaut 10)")
    ap.add_argument("--gtfs", default=DEFAULT_GTFS)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    t_start = time.time()
    os.makedirs(args.out, exist_ok=True)
    alertes = []
    rejets = Counter()

    # 0) journée de service : dernier mercredi dans la fenêtre du feed (défaut)
    cal_min, cal_max = "99999999", "00000000"
    for row in read_rows(os.path.join(args.gtfs, "calendar.txt")):
        cal_min = min(cal_min, row["start_date"])
        cal_max = max(cal_max, row["end_date"])
    if args.date:
        ymd = args.date
    else:
        dmax = date(int(cal_max[:4]), int(cal_max[4:6]), int(cal_max[6:]))
        ymd = (dmax - timedelta(days=(dmax.weekday() - 2) % 7)).strftime("%Y%m%d")
    print(f"[1/7] Journée de service : {ymd} (fenêtre GTFS {cal_min} -> {cal_max})")

    # 1) routes métro + services actifs
    routes = load_routes(args.gtfs)
    route_ref_by_id = {r["route_id"]: r["ref"] for r in routes}
    active = load_active_services(args.gtfs, ymd)
    print(f"[2/7] {len(routes)} lignes de métro, {len(active)} services actifs")

    # 2) courses métro du jour
    trips = {}
    for row in read_rows(os.path.join(args.gtfs, "trips.txt")):
        ref = route_ref_by_id.get(row["route_id"])
        if ref is None or row["service_id"] not in active:
            continue
        trips[row["trip_id"]] = (ref, row["shape_id"], row["trip_headsign"],
                                 int(row["direction_id"] or 0))
    print(f"[3/7] {len(trips)} courses métro retenues")

    # 3) shapes + coordonnées d'arrêts
    shapes = load_shapes(args.gtfs)
    stops_xy = {}
    for row in read_rows(os.path.join(args.gtfs, "stops.txt")):
        stops_xy[row["stop_id"]] = (float(row["stop_lat"]), float(row["stop_lon"]))

    # 4) stop_times : une seule passe sur le gros fichier
    st_by_trip = {}
    with open(os.path.join(args.gtfs, "stop_times.txt"), encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        i_trip = header.index("trip_id")
        i_stop = header.index("stop_id")
        i_arr = header.index("arrival_time")
        i_dep = header.index("departure_time")
        i_seq = header.index("stop_sequence")
        for row in reader:
            tid = row[i_trip]
            if tid in trips:
                st_by_trip.setdefault(tid, []).append(
                    (int(row[i_seq]), row[i_stop], row[i_arr], row[i_dep]))
    print(f"[4/7] stop_times chargés pour {len(st_by_trip)} courses")

    # 5) profil horaire + échantillonnage + binaire
    buf = bytearray()
    buf += MAGIC + struct.pack("<HHI", VERSION, args.dt, 0)  # n_trips patché à la fin
    trips_meta = []
    durations = []
    minute_counts = [0] * (27 * 60)  # présence véhicules par minute, 00:00 -> 27:00
    lat_min = lat_max = lon_min = lon_max = None

    for tid in sorted(trips):
        ref, shape_id, headsign, direction = trips[tid]
        shape = shapes.get(shape_id)
        if shape is None:
            rejets["sans_shape"] += 1
            continue
        raw = st_by_trip.get(tid)
        if not raw or len(raw) < 2:
            rejets["sans_horaires"] += 1
            continue
        raw.sort(key=lambda s: s[0])

        t_arr = [parse_gtfs_time(s[2]) for s in raw]
        t_dep = [parse_gtfs_time(s[3]) for s in raw]
        if any(t_arr[i] < t_dep[i - 1] for i in range(1, len(raw))):
            rejets["inversion_temps"] += 1
            continue

        slat, slon, missing = [], [], False
        for s in raw:
            xy = stops_xy.get(s[1])
            if xy is None:
                missing = True
                break
            slat.append(xy[0])
            slon.append(xy[1])
        if missing:
            rejets["stop_inconnu"] += 1
            continue

        stop_d = project_stop_dists(shape, slat, slon)

        # points de contrôle (t, d) : arrivée + départ à chaque arrêt intermédiaire
        ctrl_t = [t_dep[0]]
        ctrl_d = [stop_d[0]]
        for i in range(1, len(raw) - 1):
            a = t_arr[i]
            d = max(a, t_dep[i])  # dwell clampé si incohérence bénigne
            if a > ctrl_t[-1]:
                ctrl_t.append(a)
                ctrl_d.append(stop_d[i])
            ctrl_t.append(d)
            ctrl_d.append(stop_d[i])
        if t_arr[-1] > ctrl_t[-1]:
            ctrl_t.append(t_arr[-1])
            ctrl_d.append(stop_d[-1])

        # sécurité : points de contrôle strictement croissants en temps
        mc_t, mc_d = [ctrl_t[0]], [ctrl_d[0]]
        for tt, dd in zip(ctrl_t[1:], ctrl_d[1:]):
            if tt > mc_t[-1]:
                mc_t.append(tt)
                mc_d.append(dd)
        ctrl_t, ctrl_d = mc_t, mc_d
        if len(ctrl_t) < 2:
            rejets["inversion_temps"] += 1
            continue

        t0, t1 = ctrl_t[0], ctrl_t[-1]
        span = t1 - t0
        if span > MAX_TRIP_SPAN_S:
            rejets["trop_longue"] += 1
            continue

        n_points = span // args.dt + 1
        pts = bytearray()
        ok = True
        for k in range(n_points):
            t = t1 if k == n_points - 1 else t0 + k * args.dt
            d = interp_on(ctrl_t, ctrl_d, t)
            la, lo = dist_to_latlon(shape, d)
            if not (BBOX[0] - BBOX_MARGE <= la <= BBOX[2] + BBOX_MARGE
                    and BBOX[1] - BBOX_MARGE <= lo <= BBOX[3] + BBOX_MARGE):
                ok = False
                break
            pts += POINT_FMT.pack(la, lo, t - t0)
            if lat_min is None:
                lat_min = lat_max = la
                lon_min = lon_max = lo
            else:
                lat_min, lat_max = min(lat_min, la), max(lat_max, la)
                lon_min, lon_max = min(lon_min, lo), max(lon_max, lo)
        if not ok:
            rejets["hors_bounds"] += 1
            continue

        buf += TRIP_HDR_FMT.pack(ref, t0, n_points) + pts
        trips_meta.append([ref, t0, n_points, headsign, direction])
        durations.append(span)
        for m in range(t0 // 60, min(t1 // 60 + 1, len(minute_counts))):
            minute_counts[m] += 1

    n_trips = len(trips_meta)
    struct.pack_into("<I", buf, 12, n_trips)  # patch du header
    print(f"[5/7] {n_trips} courses échantillonnées (dt={args.dt}s) — "
          f"rejets: {dict(rejets) if rejets else 'aucun'}")

    with open(os.path.join(args.out, "metro.bin"), "wb") as f:
        f.write(buf)

    # 6) trips.json (index) + stats.json
    stats = build_stats(routes, trips_meta, durations, minute_counts, dict(rejets),
                        alertes, ymd, args.dt, cal_min, cal_max,
                        lat_min, lat_max, lon_min, lon_max)
    index = {
        "date": ymd,
        "dt": args.dt,
        "routes": [{"ref": r["ref"], "line": r["line"], "color": r["color"],
                    "text_color": r["text_color"], "long_name": r["long_name"]} for r in routes],
        "trips": trips_meta,
    }
    with open(os.path.join(args.out, "trips.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(args.out, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)

    # 7) lines.geojson : shape dominant par (ligne, sens)
    write_lines_geojson(args.out, shapes, trips, routes)
    print("[6/7] lines.geojson écrit")

    elapsed = time.time() - t_start
    print(f"[7/7] Terminé en {elapsed:.1f} s — metro.bin {len(buf)/1e6:.2f} Mo, "
          f"{n_trips} courses, pic {stats['peak_simultaneous']} véhicules à {stats['peak_time']}")
    return 0


def build_stats(routes, trips_meta, durations, minute_counts, rejets, alertes,
                ymd, dt, cal_min, cal_max, lat_min, lat_max, lon_min, lon_max):
    durations.sort()
    peak = max(minute_counts)
    peak_min = minute_counts.index(peak)
    hourly_max = []
    for h in range(27):
        window = minute_counts[h * 60:(h + 1) * 60]
        hourly_max.append(max(window) if window else 0)
    last_arr = max((t[1] + (t[2] - 1) * dt for t in trips_meta), default=0)
    return {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "date": ymd,
        "dt": dt,
        "mode": "metro",
        "license": "Données : STIB-MIVB, CC BY 4.0 (GTFS via data.gtfs.be)",
        "routes_count": len(routes),
        "trips": len(trips_meta),
        "rejected": rejets,
        "first_departure": trips_meta[0][1] if trips_meta else 0,
        "last_arrival": last_arr,
        "peak_simultaneous": peak,
        "peak_time": fmt_hms(peak_min * 60),
        "hourly_max": hourly_max,
        "duration_s": {"min": durations[0] if durations else 0,
                       "median": durations[len(durations) // 2] if durations else 0,
                       "max": durations[-1] if durations else 0},
        "bbox": {"lat_min": lat_min, "lon_min": lon_min,
                 "lat_max": lat_max, "lon_max": lon_max},
        "feed_window": {"start": cal_min, "end": cal_max},
        "timeline_end_s": 25 * 3600,
    }


def write_lines_geojson(out_dir, shapes, trips, routes):
    """Pour chaque (ligne, sens) : shape_id le plus fréquent + terminus dominant."""
    route_by_ref = {r["ref"]: r for r in routes}
    shape_freq = {}
    headsign_freq = {}
    for ref, shape_id, headsign, direction in trips.values():
        if shape_id not in shapes:
            continue
        shape_freq.setdefault((ref, direction), Counter())[shape_id] += 1
        headsign_freq.setdefault((ref, direction), Counter())[headsign] += 1

    features = []
    for (ref, direction) in sorted(shape_freq):
        shape_id = shape_freq[(ref, direction)].most_common(1)[0][0]
        lats, lons, _ = shapes[shape_id]
        route = route_by_ref[ref]
        features.append({
            "type": "Feature",
            "properties": {
                "line": route["line"],
                "color": route["color"],
                "direction": direction,
                "terminus": headsign_freq[(ref, direction)].most_common(1)[0][0],
            },
            "geometry": {"type": "LineString",
                         "coordinates": [[round(lo, 5), round(la, 5)] for la, lo in zip(lats, lons)]},
        })
    fc = {"type": "FeatureCollection", "features": features}
    with open(os.path.join(out_dir, "lines.geojson"), "w", encoding="utf-8") as f:
        json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    sys.exit(main())
