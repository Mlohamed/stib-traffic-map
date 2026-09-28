#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STIB TRAFFIC MAP — assemblage de la démo standalone P0.
Injecte data_out/* (binaire base64 + JSON) dans app/template.html -> app/index.html
+ copie versionnée à la racine. Zéro dépendance (stdlib).
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
TEMPLATE = os.path.join(HERE, "template.html")
VERSION = "1.0"


def main():
    with open(os.path.join(OUT, "metro.bin"), "rb") as f:
        binaire = base64.b64encode(f.read()).decode("ascii")
    with open(os.path.join(OUT, "trips.json"), encoding="utf-8") as f:
        trips = json.load(f)
    with open(os.path.join(OUT, "stats.json"), encoding="utf-8") as f:
        stats = json.load(f)
    with open(os.path.join(OUT, "lines.geojson"), encoding="utf-8") as f:
        lignes = json.load(f)

    payload = {"bin": binaire, "trips": trips, "stats": stats, "lines": lignes}
    payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    with open(TEMPLATE, encoding="utf-8") as f:
        html = f.read()
    if "__DATA_JSON__" not in html:
        sys.exit("ERREUR : jeton __DATA_JSON__ absent du template")
    html = html.replace("__DATA_JSON__", payload_json)

    cible_app = os.path.join(HERE, "index.html")
    with open(cible_app, "w", encoding="utf-8") as f:
        f.write(html)
    cible_root = os.path.join(ROOT, f"STIBMAP_Metro_v{VERSION}_local.html")
    with open(cible_root, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"index.html        : {os.path.getsize(cible_app)/1e6:.2f} Mo")
    print(f"livrable racine   : {os.path.basename(cible_root)} ({os.path.getsize(cible_root)/1e6:.2f} Mo)")
    print(f"courses embarquées: {stats['trips']} — date service {stats['date']}")


if __name__ == "__main__":
    main()
