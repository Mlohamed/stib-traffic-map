#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STIB TRAFFIC MAP — build P1 (GO tram) : MÉTRO + TRAM.
Réutilise les fonctions validées de build_p0.py (projection, interpolation, format binaire).
Sorties : metro.bin (dt=10), tram.bin (dt=15), routes.json (table globale 22 lignes),
network.json (stats par mode + combiné), lines.geojson (2 modes).
P0 reste reproductible via build_p0.py --modes metro.
"""
import argparse
import bisect
import csv
import json
import os
import struct
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_p0 import (  # noqa: E402 — fonctions prouvées P0
    BBOX, BBOX_MARGE, MAGIC, MAX_TRIP_SPAN_S, POINT_FMT, TRIP_HDR_FMT, VERSION,
    dist_to_latlon, fmt_hms, interp_on, load_active_services, load_shapes,
    parse_gtfs_time, project_stop_dists, read_rows,
)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(HERE)
DEFAULT_GTFS = os.path.join(ROOT, "data", "gtfs")
DEFAULT_OUT = os.path.join(ROOT, "data_out")

MODES = {  # route_type GTFS + pas d'échantillonnage (bus plus lents -> dt=20)
    "metro": {"route_type": "1", "dt": 10},
    "tram": {"route_type": "0", "dt": 15},
    "bus": {"route_type": "3", "dt": 20},
}


def haversine_km(lat1, lon1, lat2, lon2):
    import math
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(a))


def load_routes_multi(gtfs, wanted):
    """Table globale des lignes des modes demandés. Réfs globales : métro d'abord."""
    all_routes = []
    for mode in wanted:
        rt = MODES[mode]["route_type"]
        routes = []
        for row in read_rows(os.path.join(gtfs, "routes.txt")):
            if row["route_type"] == rt:
                routes.append({
                    "route_id": row["route_id"],
                    "line": row["route_short_name"],
                    "long_name": row["route_long_name"],
                    "color": row["route_color"].lstrip("#").upper(),
                    "text_color": row["route_text_color"].lstrip("#").upper(),
                    "mode": mode,
                })
        def key(r):
            try:
                return (0, int(r["line"]), r["line"])
            except ValueError:
                return (1, 0, r["line"])
        routes.sort(key=key)
        all_routes.extend(routes)
    for ref, r in enumerate(all_routes):
        r["ref"] = ref
    return all_routes


def build_mode(mode, trips_of_mode, shapes, stops_xy, st_by_trip, dt, rej_mode):
    """Échantillonne les courses d'un mode -> (buf, trips_meta, durations, minute_counts).
    Réutilise strictement la logique P0 (projection à patience, ctrl points, clamp)."""
    buf = bytearray()
    buf += MAGIC + struct.pack("<HHI", VERSION, dt, 0)
    trips_meta = []
    durations = []
    minute_counts = [0] * (27 * 60)

    for tid in sorted(trips_of_mode):
        ref, shape_id, headsign, direction = trips_of_mode[tid]
        shape = shapes.get(shape_id)
        if shape is None:
            rej_mode["sans_shape"] += 1
            continue
        raw = st_by_trip.get(tid)
        if not raw or len(raw) < 2:
            rej_mode["sans_horaires"] += 1
            continue
        raw.sort(key=lambda s: s[0])

        t_arr = [parse_gtfs_time(s[2]) for s in raw]
        t_dep = [parse_gtfs_time(s[3]) for s in raw]
        if any(t_arr[i] < t_dep[i - 1] for i in range(1, len(raw))):
            rej_mode["inversion_temps"] += 1
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
            rej_mode["stop_inconnu"] += 1
            continue

        stop_d = project_stop_dists(shape, slat, slon)

        ctrl_t = [t_dep[0]]
        ctrl_d = [stop_d[0]]
        for i in range(1, len(raw) - 1):
            a = t_arr[i]
            d = max(a, t_dep[i])
            if a > ctrl_t[-1]:
                ctrl_t.append(a)
                ctrl_d.append(stop_d[i])
            ctrl_t.append(d)
            ctrl_d.append(stop_d[i])
        if t_arr[-1] > ctrl_t[-1]:
            ctrl_t.append(t_arr[-1])
            ctrl_d.append(stop_d[-1])

        mc_t, mc_d = [ctrl_t[0]], [ctrl_d[0]]
        for tt, dd in zip(ctrl_t[1:], ctrl_d[1:]):
            if tt > mc_t[-1]:
                mc_t.append(tt)
                mc_d.append(dd)
        ctrl_t, ctrl_d = mc_t, mc_d
        if len(ctrl_t) < 2:
            rej_mode["inversion_temps"] += 1
            continue

        t0, t1 = ctrl_t[0], ctrl_t[-1]
        span = t1 - t0
        if span > MAX_TRIP_SPAN_S:
            rej_mode["trop_longue"] += 1
            continue

        n_points = span // dt + 1
        pts = bytearray()
        ok = True
        for k in range(n_points):
            t = t1 if k == n_points - 1 else t0 + k * dt
            d = interp_on(ctrl_t, ctrl_d, t)
            la, lo = dist_to_latlon(shape, d)
            if not (BBOX[0] - BBOX_MARGE <= la <= BBOX[2] + BBOX_MARGE
                    and BBOX[1] - BBOX_MARGE <= lo <= BBOX[3] + BBOX_MARGE):
                ok = False
                break
            pts += POINT_FMT.pack(la, lo, t - t0)
        if not ok:
            rej_mode["hors_bounds"] += 1
            continue

        buf += TRIP_HDR_FMT.pack(ref, t0, n_points) + pts
        trips_meta.append([ref, t0, n_points, headsign, direction])
        durations.append(span)
        for m in range(t0 // 60, min(t1 // 60 + 1, len(minute_counts))):
            minute_counts[m] += 1

    struct.pack_into("<I", buf, 12, len(trips_meta))
    return buf, trips_meta, durations, minute_counts


def main():
    ap = argparse.ArgumentParser(description="Build P1 STIB Traffic Map (métro + tram)")
    ap.add_argument("--modes", default="metro,tram")
    ap.add_argument("--date", default=None)
    ap.add_argument("--gtfs", default=DEFAULT_GTFS)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()
    wanted = [m.strip() for m in args.modes.split(",") if m.strip() in MODES]
    if not wanted:
        sys.exit("aucun mode valide dans --modes")

    t_start = time.time()
    os.makedirs(args.out, exist_ok=True)
    rejets = {m: Counter() for m in wanted}

    # journée de service (dernier mercredi de la fenêtre par défaut)
    cal_min, cal_max = "99999999", "00000000"
    for row in read_rows(os.path.join(args.gtfs, "calendar.txt")):
        cal_min = min(cal_min, row["start_date"])
        cal_max = max(cal_max, row["end_date"])
    if args.date:
        ymd = args.date
    else:
        dmax = date(int(cal_max[:4]), int(cal_max[4:6]), int(cal_max[6:]))
        ymd = (dmax - timedelta(days=(dmax.weekday() - 2) % 7)).strftime("%Y%m%d")
    print(f"[1/7] Journée de service : {ymd} (modes: {', '.join(wanted)})")

    routes = load_routes_multi(args.gtfs, wanted)
    mode_of_ref = {r["ref"]: r["mode"] for r in routes}
    route_line = {r["route_id"]: r for r in routes}
    active = load_active_services(args.gtfs, ymd)
    n_metro = sum(1 for r in routes if r["mode"] == "metro")
    print(f"[2/7] {len(routes)} lignes ({n_metro} métro + {len(routes)-n_metro} tram), "
          f"{len(active)} services actifs")

    # courses des modes retenus
    selected = {}  # trip_id -> (ref, shape_id, headsign, direction)
    for row in read_rows(os.path.join(args.gtfs, "trips.txt")):
        r = route_line.get(row["route_id"])
        if r is None or r["mode"] not in wanted:
            continue
        if row["service_id"] not in active:
            continue
        selected[row["trip_id"]] = (r["ref"], row["shape_id"], row["trip_headsign"],
                                    int(row["direction_id"] or 0))
    print(f"[3/7] {len(selected)} courses retenues (tous modes)")

    shapes = load_shapes(args.gtfs)
    stops_xy = {}
    for row in read_rows(os.path.join(args.gtfs, "stops.txt")):
        stops_xy[row["stop_id"]] = (float(row["stop_lat"]), float(row["stop_lon"]))

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
            if tid in selected:
                st_by_trip.setdefault(tid, []).append(
                    (int(row[i_seq]), row[i_stop], row[i_arr], row[i_dep]))
    print(f"[4/7] stop_times chargés pour {len(st_by_trip)} courses")

    # build par mode
    results = {}
    combined_minutes = [0] * (27 * 60)
    for mode in wanted:
        trips_of_mode = {tid: v for tid, v in selected.items()
                         if mode_of_ref[v[0]] == mode}
        dt = MODES[mode]["dt"]
        buf, trips_meta, durations, minutes = build_mode(
            mode, trips_of_mode, shapes, stops_xy, st_by_trip, dt, rejets[mode])
        with open(os.path.join(args.out, f"{mode}.bin"), "wb") as f:
            f.write(buf)
        durations.sort()
        peak = max(minutes)
        results[mode] = {
            "file": f"{mode}.bin", "dt": dt,
            "trips": len(trips_meta),
            "bytes": len(buf),
            "first_departure": trips_meta[0][1] if trips_meta else 0,
            "last_arrival": max((t[1] + (t[2] - 1) * dt for t in trips_meta), default=0),
            "peak_simultaneous": peak,
            "peak_time": fmt_hms(minutes.index(peak) * 60),
            "hourly_max": [max(minutes[h * 60:(h + 1) * 60]) if minutes[h * 60:(h + 1) * 60] else 0
                           for h in range(27)],
            "duration_s": {"min": durations[0] if durations else 0,
                           "median": durations[len(durations) // 2] if durations else 0,
                           "max": durations[-1] if durations else 0},
            "rejected": dict(rejets[mode]),
        }
        for m in range(27 * 60):
            combined_minutes[m] += minutes[m]
        print(f"[5/7] {mode}: {len(trips_meta)} courses (dt={dt}s), "
              f"{len(buf)/1e6:.2f} Mo, pic {peak} à {results[mode]['peak_time']}, "
              f"rejets {dict(rejets[mode]) or 'aucun'}")

    peak_c = max(combined_minutes)
    network = {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "date": ymd,
        "modes": results,
        "routes_count": len(routes),
        "trips_total": sum(results[m]["trips"] for m in wanted),
        "combined": {
            "peak_simultaneous": peak_c,
            "peak_time": fmt_hms(combined_minutes.index(peak_c) * 60),
            "hourly_max": [max(combined_minutes[h * 60:(h + 1) * 60])
                           if combined_minutes[h * 60:(h + 1) * 60] else 0 for h in range(27)],
        },
        "timeline_end_s": 25 * 3600,
        "license": "Données : STIB-MIVB, CC BY 4.0 (GTFS via data.gtfs.be)",
        "feed_window": {"start": cal_min, "end": cal_max},
    }
    with open(os.path.join(args.out, "network.json"), "w", encoding="utf-8") as f:
        json.dump(network, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, "routes.json"), "w", encoding="utf-8") as f:
        json.dump({"routes": [{k: r[k] for k in ("ref", "line", "color", "text_color",
                                                 "long_name", "mode")} for r in routes]},
                  f, ensure_ascii=False, separators=(",", ":"))

    # lines.geojson (2 modes)
    write_lines_geojson(args.out, shapes, selected, routes)
    print("[6/7] lines.geojson écrit (métro + tram)")
    print(f"[7/7] Terminé en {time.time()-t_start:.0f} s — total {network['trips_total']} courses")
    return 0


def write_lines_geojson(out_dir, shapes, selected, routes):
    route_by_ref = {r["ref"]: r for r in routes}
    shape_freq = {}
    headsign_freq = {}
    for ref, shape_id, headsign, direction in selected.values():
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
            "properties": {"ref": ref, "line": route["line"], "color": route["color"],
                           "mode": route["mode"], "direction": direction,
                           "terminus": headsign_freq[(ref, direction)].most_common(1)[0][0]},
            "geometry": {"type": "LineString",
                         "coordinates": [[round(lo, 5), round(la, 5)] for la, lo in zip(lats, lons)]},
        })
    with open(os.path.join(out_dir, "lines.geojson"), "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features},
                  f, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    sys.exit(main())
