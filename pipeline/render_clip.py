#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
STIB TRAFFIC MAP — rendu du clip « journée complète » (P0).
Rendu image par image via Edge headless (?t=...&pause=1&noclean=1 pour cacher HUD),
assemblage ffmpeg H.264. Sortie : clip_stibmap_p0.mp4 à la racine du repo.

Usage : python pipeline/render_clip.py [--fps 24] [--duree-s 45]
Prérequis : data_out/ généré, app/index.html assemblé (build_standalone.py).
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRATCH = os.path.join(os.environ.get("TMPDIR", os.path.join(ROOT, "data_out")), "clip_frames")
HTML = os.path.join(ROOT, "STIBMAP_Metro_v1.0_local.html")

# Edge : premier trouvé
for c in [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]:
    if os.path.isfile(c):
        EDGE = c
        break
else:
    sys.exit("Edge introuvable")

# ffmpeg : PATH puis dossier Hermes
FFMPEG = shutil.which("ffmpeg") or ""
if not FFMPEG:
    for c in os.listdir(os.path.join(os.path.expanduser("~"), "AppData", "Local", "hermes", "tools")):
        pass
    import glob
    g = glob.glob(os.path.expanduser("~/AppData/Local/hermes/tools/ffmpeg*/bin/ffmpeg.exe"))
    if g:
        FFMPEG = g[0]
if not FFMPEG:
    sys.exit("ffmpeg introuvable")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--duree-s", type=int, default=45, help="durée cible du clip en secondes")
    ap.add_argument("--out", default=os.path.join(ROOT, "clip_stibmap_p0.mp4"))
    args = ap.parse_args()

    # la journée simulée va de 04:00 à 25:30 (77 100 s) -> compression temporelle
    T_START, T_END = 4 * 3600, 25 * 3600 + 1800
    n_frames = args.fps * args.duree_s
    dt_clip = (T_END - T_START) // n_frames

    if os.path.isdir(SCRATCH):
        shutil.rmtree(SCRATCH)
    os.makedirs(SCRATCH, exist_ok=True)

    t0 = time.time()
    print(f"Rendu {n_frames} frames ({args.duree_s}s à {args.fps} fps), "
          f"Δt sim = {dt_clip}s/frame — cible {args.out}")
    for i in range(n_frames):
        t = T_START + i * dt_clip
        png = os.path.join(SCRATCH, f"f{i:04d}.png")
        url = f"file:///{HTML}?t={t}&pause=1".replace("\\", "/")
        r = subprocess.run(
            [EDGE, "--headless", "--disable-gpu", "--window-size=1920,1080",
             "--virtual-time-budget=4000", f"--screenshot={png}", url],
            capture_output=True, timeout=60)
        if not os.path.isfile(png):
            sys.exit(f"frame {i} manquante — arrêt")
        if i % 60 == 0:
            print(f"  [{i}/{n_frames}] t={t//3600}h{(t%3600)//60:02d} "
                  f"({time.time()-t0:.0f}s)")

    print("Assemblage ffmpeg…")
    r = subprocess.run([
        FFMPEG, "-y", "-framerate", str(args.fps),
        "-i", os.path.join(SCRATCH, "f%04d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
        "-movflags", "+faststart", args.out,
    ], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("ffmpeg KO: " + r.stderr[-400:])
    mo = os.path.getsize(args.out) / 1e6
    print(f"OK — {args.out} ({mo:.1f} Mo, {n_frames} frames, "
          f"{time.time()-t0:.0f}s de rendu)")
    shutil.rmtree(SCRATCH, ignore_errors=True)


if __name__ == "__main__":
    main()
