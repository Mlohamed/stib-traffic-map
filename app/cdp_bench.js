/**
 * Banc CDP zéro dépendance (Node >= 22 : WebSocket natif) — Edge headless.
 * Usage : node app/cdp_bench.js <page.html> [--shots <dossier>] [--port 9333]
 *  - benchmark dessiner() au pic t=61380 (17:03), 1920x1080, médiane/p95 sur N frames
 *  - captures optionnelles : splash, 07:07, 17:03, mode suivi
 * Profil Edge isolé (scratch) ; ne touche à aucun autre process/port.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const args = process.argv.slice(2);
const page = path.resolve(args[0]);
const shotsDir = args.includes("--shots") ? path.resolve(args[args.indexOf("--shots") + 1]) : null;
const PORT = args.includes("--port") ? +args[args.indexOf("--port") + 1] : 9333;
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
              "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync);
// profil Edge jetable : dossier dédié du repo (ignoré par git), jamais le Temp système
const BASE_PROFILS = path.join(__dirname, "..", ".bench");
fs.mkdirSync(BASE_PROFILS, { recursive: true });
const profil = fs.mkdtempSync(path.join(BASE_PROFILS, "edge-"));
const url = "file:///" + page.replace(/\\/g, "/");

const GPU = args.includes("--gpu");
const HEADED = args.includes("--headed"); // vraie fenêtre (pipeline d'affichage réel, vsync) — mesure fps la plus honnête
const edge = spawn(EDGE, [...(HEADED ? ["--new-window", "--window-position=0,0"] : ["--headless=new"]), `--remote-debugging-port=${PORT}`, `--user-data-dir=${profil}`,
  "--window-size=1920,1080", "--hide-scrollbars", "--no-first-run", "--disable-extensions",
  ...(GPU ? ["--enable-gpu", "--ignore-gpu-blocklist", "--disable-frame-rate-limit"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
  "about:blank"], { stdio: "ignore" });

const dormir = ms => new Promise(r => setTimeout(r, ms));
// arrêt garanti de TOUT l'arbre Edge lancé ici (et seulement lui), même sur erreur/Ctrl+C
function tuerEdge() {
  try { require("child_process").execFileSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
}
process.on("exit", tuerEdge);
process.on("SIGINT", () => process.exit(130));
async function cible() {
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find(x => x.type === "page");
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await dormir(250);
  }
  throw new Error("Edge CDP injoignable");
}
let ws, seq = 0; const attente = new Map();
function cmd(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((ok, ko) => attente.set(id, { ok, ko }));
}
async function evalJS(expr) {
  const r = await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function capture(nom) {
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  const f = path.join(shotsDir, nom + ".png");
  fs.writeFileSync(f, Buffer.from(r.data, "base64"));
  console.log("capture", f);
}
async function charger(q) {
  await cmd("Page.navigate", { url: url + q });
  for (let i = 0; i < 120; i++) {
    await dormir(250);
    try { if (await evalJS("!!window.__APP")) return; } catch (e) { var derniere = e.message; }
  }
  let etat = "?"; try { etat = await evalJS("location.href.slice(0,80) + ' ' + document.readyState"); } catch (e) { etat = e.message; }
  throw new Error("__APP jamais exposé — " + etat + " / " + derniere);
}

(async () => {
  try {
    ws = new WebSocket(await cible());
    await new Promise(r => ws.addEventListener("open", r));
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.id && attente.has(m.id)) { const a = attente.get(m.id); attente.delete(m.id); m.error ? a.ko(new Error(m.error.message)) : a.ok(m.result); }
    });
    await cmd("Page.enable"); await cmd("Runtime.enable");
    await cmd("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

    // ---------- benchmark ----------
    await charger("?t=61380&pause=1");
    await dormir(800);
    const bench = await evalJS(`(() => {
      const A = window.__APP, N = 120, ts = [];
      for (let i = 0; i < 10; i++) A.dessiner(61380 + i);           // chauffe JIT
      for (let i = 0; i < N; i++) { const t0 = performance.now(); A.dessiner(61380 + i * 0.5); ts.push(performance.now() - t0); }
      ts.sort((a, b) => a - b);
      return { n: N, med: ts[N >> 1], p95: ts[Math.floor(N * 0.95)], min: ts[0],
               veh: A.positions(61380).length, extra: A.benchInfo ? A.benchInfo() : null };
    })()`);
    console.log("BENCH dessiner(t=61380) 1920x1080 :", JSON.stringify(bench));

    // fps réel : boucle rAF de l'app en lecture ×60 autour du pic, 4 s (vue d'ensemble puis suivi si dispo)
    const PRE = args.includes("--pre") ? args[args.indexOf("--pre") + 1] : "";
    const fpsReel = async (prep) => evalJS(`(async () => {
      const A = window.__APP; A.tSim = 61380; ${PRE}; ${prep}
      document.getElementById("btn-play").click();
      await new Promise(r => setTimeout(r, 500));
      const ts = []; let fin = performance.now() + 4000;
      await new Promise(r => { (function f(n) { ts.push(n); if (n < fin) requestAnimationFrame(f); else r(); })(performance.now()); });
      document.getElementById("btn-play").click();
      const d = ts.slice(1).map((v, i) => v - ts[i]).sort((a, b) => a - b);
      return { fps: +(1000 / (d.reduce((s, v) => s + v, 0) / d.length)).toFixed(1), p95ms: +d[Math.floor(d.length * .95)].toFixed(1),
               jsParFrame: A.jsFrame ? A.jsFrame() : null };
    })()`);
    console.log("FPS réel vue d'ensemble :", JSON.stringify(await fpsReel("")));
    if (await evalJS("!!window.__APP.suivreAuto"))
      console.log("FPS réel mode suivi    :", JSON.stringify(await fpsReel("A.suivreAuto(61380);")));

    if (shotsDir) {
      fs.mkdirSync(shotsDir, { recursive: true });
      const erreurs = [];
      ws.addEventListener("message", ev => { const m = JSON.parse(ev.data);
        if (m.method === "Runtime.exceptionThrown") erreurs.push(m.params.exceptionDetails.exception?.description?.split("\n").slice(0, 2).join(" | ")); });
      await cmd("Page.navigate", { url });
      const tNav = Date.now();
      for (let i = 0; i < 80 && !(await evalJS("!!window.__APP").catch(() => false)); i++) await dormir(100);
      console.log("init splash → __APP :", Date.now() - tNav, "ms", JSON.stringify(await evalJS("[window.__m0, window.__m1, window.__marks]").catch(() => null)));
      await dormir(4500);
      console.log("splash :", await evalJS("['sp-courses','sp-lignes','sp-pic','sp-points'].map(i => document.getElementById(i).textContent).join(' / ')"),
                  erreurs.length ? "ERREURS " + JSON.stringify([...new Set(erreurs)]) : "sans erreur JS");
      await capture("01_splash");
      await charger("?t=25620&pause=1"); await dormir(1500); await capture("02_0707");
      await charger("?t=61380&pause=1"); await dormir(1500); await capture("03_1703");
      const suivi = await evalJS("window.__APP.suivreAuto ? window.__APP.suivreAuto(61380) : null");
      if (suivi) { await dormir(2600); await capture("04_suivi"); console.log("suivi :", JSON.stringify(suivi)); }
      const hm = await evalJS("window.__APP.basculerHeatmap ? (window.__APP.suivre && window.__APP.suivre(null), window.__APP.basculerHeatmap(true), true) : false");
      if (hm) { await dormir(2400); await capture("05_heatmap_1703"); }
    }
  } catch (e) { console.error("ERREUR", e.message); process.exitCode = 1; }
  finally {
    try { ws && ws.close(); } catch {}
    tuerEdge();
    await dormir(800);
    try { fs.rmSync(profil, { recursive: true, force: true }); } catch {}
  }
})();
