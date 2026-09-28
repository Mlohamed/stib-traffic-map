#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STIB TRAFFIC MAP — assemblage standalone P1 (métro + tram).
Injecte data_out/{metro.bin,tram.bin,routes.json,network.json,lines.geojson}
dans app/template_p1.html -> app/index_p1.html + livrable racine versionné.
"""
import base64
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data_out")
TEMPLATE = os.path.join(HERE, "template_p1.html")
VERSION = "1.1"


def main():
    payload = {
        "bins": {},
        "routes": json.load(open(os.path.join(OUT, "routes.json"), encoding="utf-8")),
        "network": json.load(open(os.path.join(OUT, "network.json"), encoding="utf-8")),
        "lines": json.load(open(os.path.join(OUT, "lines.geojson"), encoding="utf-8")),
    }
    for mode in ("metro", "tram"):
        with open(os.path.join(OUT, f"{mode}.bin"), "rb") as f:
            payload["bins"][mode] = base64.b64encode(f.read()).decode("ascii")

    payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    html = open(TEMPLATE, encoding="utf-8").read()
    if "__DATA_JSON__" not in html:
        sys.exit("ERREUR : jeton __DATA_JSON__ absent du template")
    html = html.replace("__DATA_JSON__", payload_json)

    cible_app = os.path.join(HERE, "index_p1.html")
    open(cible_app, "w", encoding="utf-8").write(html)
    cible_root = os.path.join(ROOT, f"STIBMAP_MetroTram_v{VERSION}_local.html")
    open(cible_root, "w", encoding="utf-8").write(html)

    print(f"index_p1.html    : {os.path.getsize(cible_app)/1e6:.2f} Mo")
    print(f"livrable racine  : {os.path.basename(cible_root)} "
          f"({os.path.getsize(cible_root)/1e6:.2f} Mo)")
    print(f"courses          : {payload['network']['trips_total']} "
          f"(métro {payload['network']['modes']['metro']['trips']} + "
          f"tram {payload['network']['modes']['tram']['trips']})")


if __name__ == "__main__":
    main()
