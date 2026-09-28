#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STIB TRAFFIC MAP — build de la VERSION SITE (publication GO-2).
Depuis app/template_p1.html :
  site/index.html : le template SANS le payload inline, avec le loader fetch + <script src="app.js">
  site/app.js     : la logique de la page telle quelle (window.PAYLOAD attendu)
  site/data/*     : binaires + JSON servis séparément (cache navigateur)
"""
import json
import os
import shutil
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "data_out")
SITE = os.path.join(ROOT, "site")
TEMPLATE = os.path.join(HERE, "..", "app", "template_p1.html")


def main():
    html = open(TEMPLATE, encoding="utf-8").read()
    if "__DATA_JSON__" not in html:
        sys.exit("jeton __DATA_JSON__ absent du template")

    # 1) payload inline -> window.PAYLOAD
    html = html.replace("const PAYLOAD = __DATA_JSON__;", "const PAYLOAD = window.PAYLOAD;")

    # 2) découper le script principal
    pre, rest = html.split("<script>", 1)
    js, post = rest.split("</script>", 1)

    # 3) décodage polymorphe : Uint8Array (site) ou base64 (local)
    js = js.replace(
        "function b64versBytes(b64) {",
        "function binversBytes(x) { return x instanceof Uint8Array ? x : b64versBytes(x); }\n"
        "function b64versBytes(b64) {", 1)
    js = js.replace("const u8 = b64versBytes(PAYLOAD.bins[mode]);",
                    "const u8 = binversBytes(PAYLOAD.bins[mode]);")

    # 4) shell : loader fetch avant app.js
    loader = """<script>
(async () => {
  const [routes, network, lines, metro, tram] = await Promise.all([
    fetch("data/routes.json").then(r => r.json()),
    fetch("data/network.json").then(r => r.json()),
    fetch("data/lines.geojson").then(r => r.json()),
    fetch("data/metro.bin").then(r => r.arrayBuffer()),
    fetch("data/tram.bin").then(r => r.arrayBuffer()),
  ]);
  window.PAYLOAD = {
    bins: { metro: new Uint8Array(metro), tram: new Uint8Array(tram) },
    routes, network, lines,
  };
  const s = document.createElement("script");
  s.src = "app.js";
  document.body.appendChild(s);
})();
</script>
"""
    shell = pre + post.replace("</body>", loader + "</body>")

    os.makedirs(os.path.join(SITE, "data"), exist_ok=True)
    open(os.path.join(SITE, "index.html"), "w", encoding="utf-8").write(shell)
    open(os.path.join(SITE, "app.js"), "w", encoding="utf-8").write(js)
    for fn in ("metro.bin", "tram.bin", "routes.json", "network.json", "lines.geojson"):
        shutil.copy2(os.path.join(OUT, fn), os.path.join(SITE, "data", fn))

    total = sum(os.path.getsize(os.path.join(SITE, "data", fn)) for fn in
                ("metro.bin", "tram.bin", "lines.geojson"))
    print(f"site/index.html : {os.path.getsize(os.path.join(SITE, 'index.html'))/1e3:.1f} Ko")
    print(f"site/app.js     : {os.path.getsize(os.path.join(SITE, 'app.js'))/1e3:.1f} Ko")
    print(f"site/data       : {total/1e6:.1f} Mo (2 binaires + tracés)")


if __name__ == "__main__":
    main()
