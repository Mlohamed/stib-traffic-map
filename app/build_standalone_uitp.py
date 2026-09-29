#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STIB TRAFFIC MAP — assemblage édition UITP (vitrine internationale).
Local  : STIBMAP_UITP_v2.0_local.html (payload base64 inline, double-clic)
Site   : site/index.html + site/app.js + site/data/* (fetch, cache navigateur)
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
TEMPLATE = os.path.join(HERE, "template_uitp.html")
SITE = os.path.join(ROOT, "site")
VERSION = "2.0"


def charger_payload():
    payload = {
        "bins": {},
        "routes": json.load(open(os.path.join(OUT, "routes.json"), encoding="utf-8")),
        "network": json.load(open(os.path.join(OUT, "network.json"), encoding="utf-8")),
        "lines": json.load(open(os.path.join(OUT, "lines.geojson"), encoding="utf-8")),
    }
    for mode in ("metro", "tram", "bus"):
        with open(os.path.join(OUT, f"{mode}.bin"), "rb") as f:
            payload["bins"][mode] = base64.b64encode(f.read()).decode("ascii")
    return payload


def main():
    payload = charger_payload()
    payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    html = open(TEMPLATE, encoding="utf-8").read()
    if "__DATA_JSON__" not in html:
        sys.exit("jeton __DATA_JSON__ absent du template")

    # ---------- local ----------
    local = html.replace("__DATA_JSON__", payload_json)
    cible_local = os.path.join(ROOT, f"STIBMAP_UITP_v{VERSION}_local.html")
    open(cible_local, "w", encoding="utf-8").write(local)
    open(os.path.join(HERE, "index_uitp.html"), "w", encoding="utf-8").write(local)
    print(f"local  : {os.path.basename(cible_local)} ({os.path.getsize(cible_local)/1e6:.2f} Mo)")

    # ---------- site ----------
    site_html = html.replace("const PAYLOAD = __DATA_JSON__;", "const PAYLOAD = window.PAYLOAD;")
    pre, rest = site_html.split("<script>", 1)
    js, post = rest.split("</script>", 1)
    js = js.replace(
        "function b64versBytes(b64) {",
        "function binversBytes(x) { return x instanceof Uint8Array ? x : b64versBytes(x); }\n"
        "function b64versBytes(b64) {", 1)
    js = js.replace("const u8 = b64versBytes(PAYLOAD.bins[mode]);",
                    "const u8 = binversBytes(PAYLOAD.bins[mode]);")
    loader = """<script>
(async () => {
  const [routes, network, lines, metro, tram, bus] = await Promise.all([
    fetch("data/routes.json").then(r => r.json()),
    fetch("data/network.json").then(r => r.json()),
    fetch("data/lines.geojson").then(r => r.json()),
    fetch("data/metro.bin").then(r => r.arrayBuffer()),
    fetch("data/tram.bin").then(r => r.arrayBuffer()),
    fetch("data/bus.bin").then(r => r.arrayBuffer()),
  ]);
  window.PAYLOAD = {
    bins: { metro: new Uint8Array(metro), tram: new Uint8Array(tram), bus: new Uint8Array(bus) },
    routes, network, lines,
  };
  const s = document.createElement("script");
  s.src = "app.js";
  document.body.appendChild(s);
})();
</script>
"""
    os.makedirs(os.path.join(SITE, "data"), exist_ok=True)
    open(os.path.join(SITE, "index.html"), "w", encoding="utf-8").write(pre + post.replace("</body>", loader + "</body>"))
    open(os.path.join(SITE, "app.js"), "w", encoding="utf-8").write(js)
    for fn in ("metro.bin", "tram.bin", "bus.bin", "routes.json", "network.json", "lines.geojson"):
        with open(os.path.join(OUT, fn), "rb") as f:
            open(os.path.join(SITE, "data", fn), "wb").write(f.read())
    print(f"site   : index.html {os.path.getsize(os.path.join(SITE,'index.html'))/1e3:.1f} Ko + "
          f"app.js {os.path.getsize(os.path.join(SITE,'app.js'))/1e3:.1f} Ko + data/ (10,1 Mo)")


if __name__ == "__main__":
    main()
