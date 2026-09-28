
"use strict";
// ============================ DONNÉES (injectées au build) ============================
const PAYLOAD = window.PAYLOAD;

// ============================ DÉCODAGE DU BINAIRE (spec §5) ============================
function binversBytes(x) { return x instanceof Uint8Array ? x : b64versBytes(x); }
function b64versBytes(b64) {
  const bin = atob(b64);
  const octets = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) octets[i] = bin.charCodeAt(i);
  return octets;
}

const entetes = {};   // mode -> Uint8Array
const vues = {};      // mode -> DataView
const DTS = {};       // mode -> dt du header
for (const mode of Object.keys(PAYLOAD.bins)) {
  const u8 = binversBytes(PAYLOAD.bins[mode]);
  entetes[mode] = u8;
  vues[mode] = new DataView(u8.buffer);
  DTS[mode] = vues[mode].getUint16(10, true); // self-describing (leçon NaN)
}

// décode toutes les courses de tous les modes -> une seule liste triée par t0
const courses = [];
for (const mode of Object.keys(PAYLOAD.bins)) {
  const vue = vues[mode];
  const DTm = DTS[mode];
  const nTrips = vue.getUint32(12, true);
  let pos = 16;
  for (let i = 0; i < nTrips; i++) {
    const ref = vue.getUint8(pos);
    const t0 = vue.getUint32(pos + 1, true);
    const n = vue.getUint16(pos + 5, true);
    const base = pos + 7;
    const span = vue.getUint16(base + (n - 1) * 10 + 8, true); // pas FIXE : 10 o/point
    courses.push({ ref, t0, n, base, span, mode, DT: DTm });
    pos = base + n * 10; // pas fixe : 10 o/point
  }
}
courses.sort((a, b) => a.t0 - b.t0);

const ROUTES = PAYLOAD.routes.routes;            // {ref, line, color, mode, ...}
const STATS = PAYLOAD.network;                   // stats par mode + combiné
const LIGNES = PAYLOAD.lines.features;           // tracés geojson (avec ref + mode)

// bornes temporelles affichables
const T_MIN = 0;
const T_MAX = STATS.timeline_end_s;              // 25 h

// ============================ PROJECTION ============================
// Web Mercator locale, ajustée aux tracés du réseau.
function mercX(lon) { return lon * Math.PI / 180; }
function mercY(lat) {
  const r = lat * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
}
let bxmin = Infinity, bxmax = -Infinity, bymin = Infinity, bymax = -Infinity;
for (const f of LIGNES) {
  for (const [lon, lat] of f.geometry.coordinates) {
    const x = mercX(lon), y = mercY(lat);
    if (x < bxmin) bxmin = x; if (x > bxmax) bxmax = x;
    if (y < bymin) bymin = y; if (y > bymax) bymax = y;
  }
}
const vueCarte = { cx: (bxmin + bxmax) / 2, cy: (bymin + bymax) / 2, echelle: 1 };

function ajusterVue() {
  // dimensions CSS (innerWidth/innerHeight) : le transform dpr du contexte
  // s'occupe de la mise à l'échelle physique — ne jamais utiliser canvas.width ici.
  const marge = 70;
  const ex = (bxmax - bxmin) || 1, ey = (bymax - bymin) || 1;
  vueCarte.echelle = Math.min((innerWidth - 2 * marge) / ex, (innerHeight - 2 * marge) / ey);
}
function versEcran(x, y) {
  return [innerWidth / 2 + (x - vueCarte.cx) * vueCarte.echelle,
          innerHeight / 2 + (vueCarte.cy - y) * vueCarte.echelle];
}

// ============================ ÉTAT DE LECTURE ============================
const paramT = new URLSearchParams(location.search).get("t"); // ?t=secondes (démo/QA)
let tSim = paramT ? Number(paramT)
  : Math.max(Math.min(STATS.modes.metro.first_departure, STATS.modes.tram.first_departure) - 600, 0);
let vitesse = 300;
let enLecture = !new URLSearchParams(location.search).has("pause"); // ?pause (QA/clip)
let dernierT = performance.now();
let fpsMoyen = 0;

// ============================ CANVAS ============================
const canvas = document.getElementById("carte");
// En environnement sans canvas (jsdom), ctx devient un no-op : la logique
// (décodage, compteurs, HUD) reste testable ; le navigateur réel a le vrai ctx.
const ctxBrut = canvas.getContext ? canvas.getContext("2d") : null;
const ctx = ctxBrut || new Proxy({}, { get: () => () => {} });
function redimensionner() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = innerWidth + "px";
  canvas.style.height = innerHeight + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ajusterVue();
}
addEventListener("resize", redimensionner);
redimensionner();

// ============================ RENDU ============================
const TRAIL_S = 45;        // longueur de traînée en secondes de simulation
const W = innerWidth, H = innerHeight; // rafraîchis via redimensionner (lecture directe ci-dessous)

function positionCourse(c, t, out) {
  // interpolation entre deux échantillons (dt propre au mode : 10 s métro, 15 s tram)
  let x = (t - c.t0) / c.DT;
  if (x < 0) x = 0;
  const iMax = c.n - 1;
  if (x > iMax) x = iMax;
  const i0 = Math.min(Math.floor(x), iMax - 1);
  const fr = x - i0;
  const b0 = c.base + i0 * 10, b1 = b0 + 10; // pas fixe 10 o (2fH) — le dt ne joue que sur le temps
  const v = vues[c.mode];
  out.lat = v.getFloat32(b0, true) + fr * (v.getFloat32(b1, true) - v.getFloat32(b0, true));
  out.lon = v.getFloat32(b0 + 4, true) + fr * (v.getFloat32(b1 + 4, true) - v.getFloat32(b0 + 4, true));
  return out;
}

function dessiner(t) {
  const Wc = innerWidth, Hc = innerHeight;
  ctx.clearRect(0, 0, Wc, Hc);

  // fond : cadre très sombre + tracés (?nolines=1 : debug/QA — véhicules seuls)
  ctx.lineJoin = "round";
  if (!new URLSearchParams(location.search).has("nolines")) {
    for (const f of LIGNES) {
      const tramMode = f.properties.mode === "tram";
    const col = "#" + f.properties.color;
    ctx.beginPath();
    let premier = true;
    for (const [lon, lat] of f.geometry.coordinates) {
      const [px, py] = versEcran(mercX(lon), mercY(lat));
      if (premier) { ctx.moveTo(px, py); premier = false; } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = col;
    ctx.globalAlpha = tramMode ? 0.22 : 0.38;
    ctx.lineWidth = tramMode ? 2 : 3;
    ctx.stroke();
    ctx.globalAlpha = tramMode ? 0.06 : 0.10;
    ctx.lineWidth = tramMode ? 5 : 7;
    ctx.stroke();   // halo doux
    }
  }
  ctx.globalAlpha = 1;

  // véhicules
  const pos = { lat: 0, lon: 0 };
  const posPrec = { lat: 0, lon: 0 };
  let visibles = 0;
  const parLigne = new Array(ROUTES.length).fill(0);
  for (const c of courses) {
    if (c.t0 > t) continue;
    const fin = c.t0 + c.span;
    if (t > fin) continue;
    visibles++;
    parLigne[c.ref]++;
    positionCourse(c, t, pos);

    // traînée : échantillons récents (lus dans le binaire, pas d'historique JS)
    const iActuel = Math.min(Math.floor((t - c.t0) / c.DT), c.n - 1);
    const iTrail = Math.max(0, Math.floor((t - TRAIL_S - c.t0) / c.DT));
    const col = "#" + ROUTES[c.ref].color;
    ctx.beginPath();
    for (let i = iTrail; i <= iActuel; i++) {
      const b = c.base + i * 10; // pas fixe 10 o
      const v = vues[c.mode];
      const [px, py] = versEcran(mercX(v.getFloat32(b + 4, true)),
                                 mercY(v.getFloat32(b, true)));
      if (i === iTrail) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    const [hx, hy] = versEcran(mercX(pos.lon), mercY(pos.lat));
    ctx.lineTo(hx, hy);
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 2.4;
    ctx.stroke();

    // tête : halo + point couleur + noyau blanc
    ctx.beginPath();
    ctx.arc(hx, hy, 7, 0, 6.2832);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.25;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx, hy, 4.4, 0, 6.2832);
    ctx.globalAlpha = 0.95;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx, hy, 1.9, 0, 6.2832);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return { visibles, parLigne };
}

// ============================ HUD ============================
const elHorloge = document.getElementById("horloge");
const elCompteur = document.getElementById("compteur");
const elLegende = document.getElementById("legende");
const elStats = document.getElementById("stats-jour");
const elFps = document.getElementById("fps");
const elTimeline = document.getElementById("timeline");
const elDate = document.getElementById("date-service");
const btnPlay = document.getElementById("btn-play");

function hhmm(t) {
  t = ((t % 86400) + 86400) % 86400;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

// légende groupée par mode : MÉTRO puis TRAM
{
  const titres = { metro: "MÉTRO", tram: "TRAM" };
  let dernierMode = null;
  for (const r of ROUTES) {
    if (r.mode !== dernierMode) {
      dernierMode = r.mode;
      const h = document.createElement("div");
      h.style.cssText = "font-size:10px;letter-spacing:1.5px;color:#6b7684;margin:7px 0 2px;font-weight:700";
      h.textContent = titres[r.mode] || r.mode.toUpperCase();
      elLegende.appendChild(h);
    }
    const div = document.createElement("div");
    div.className = "ligne-item";
    div.style.cursor = "pointer";
    div.title = "Cliquer : zoom sur la ligne";
    // innerHTML sûr : données générées par le pipeline (couleur 6-hex, numéro de ligne).
    div.innerHTML = `<span class="pastille" style="background:#${r.color}"></span>
                     ${r.line}<span class="nb" id="nb-l${r.ref}">0</span>`;
    div.addEventListener("click", () => zoomLigne(r.ref));
    elLegende.appendChild(div);
  }
}

// --- zoom cinématique par ligne : clic légende = recadrage animé sur la ligne ---
let zoomActif = null; // ref de ligne zoomée, ou null = réseau complet
function zoomLigne(ref) {
  if (zoomActif === ref) { zoomActif = null; ajusterVue(); return; }
  zoomActif = ref;
  // bbox de la ligne : tracés geojson appariés par référence exacte
  const xs = [], ys = [];
  for (const f of LIGNES) {
    if (f.properties.ref !== ref) continue;
    for (const [lon, lat] of f.geometry.coordinates) {
      const x = mercX(lon), y = mercY(lat);
      xs.push(x); ys.push(y);
    }
  }
  if (!xs.length) return;
  const mx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const my = (Math.min(...ys) + Math.max(...ys)) / 2;
  const margeL = 80;
  const echCible = Math.min((innerWidth - 2 * margeL) / (Math.max(...xs) - Math.min(...xs) || 1),
                            (innerHeight - 2 * margeL) / (Math.max(...ys) - Math.min(...ys) || 1));
  // animation douce vers la cible
  const depart = { cx: vueCarte.cx, cy: vueCarte.cy, ech: vueCarte.echelle };
  const t0Anim = performance.now(), duree = 700;
  function anime(now) {
    const w = Math.min((now - t0Anim) / duree, 1);
    const e = 1 - Math.pow(1 - w, 3); // ease-out cubic
    vueCarte.cx = depart.cx + (mx - depart.cx) * e;
    vueCarte.cy = depart.cy + (my - depart.cy) * e;
    vueCarte.echelle = depart.ech + (echCible - depart.ech) * e;
    if (w < 1) requestAnimationFrame(anime);
  }
  requestAnimationFrame(anime);
}
const d = STATS.date;
elDate.textContent = `Mercredi ${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)} — horaires théoriques`;
// innerHTML sûr : valeurs chiffrées générées par le pipeline (entiers + "HH:MM").
{
  const m = STATS.modes.metro, tr = STATS.modes.tram, c = STATS.combined;
  elStats.innerHTML =
    `${STATS.trips_total.toLocaleString("fr-BE")} courses · pic combiné ${c.peak_simultaneous} véhicules à ${c.peak_time}<br>` +
    `Métro ${m.trips} (pic ${m.peak_simultaneous}) · Tram ${tr.trips} (pic ${tr.peak_simultaneous})`;
}

let dernierHud = 0;
function majHud(t, compteurs, maintenant) {
  if (maintenant - dernierHud < 200) return;
  dernierHud = maintenant;
  const j1 = t >= 86400;
  elHorloge.innerHTML = hhmm(t) + (j1 ? '<span class="j1">J+1</span>' : "");
  elCompteur.firstChild.nodeValue = compteurs ? compteurs.visibles : 0;
  if (compteurs) {
    for (let r = 0; r < ROUTES.length; r++) {
      const el = document.getElementById("nb-l" + r);
      if (el) el.textContent = compteurs.parLigne[r];
    }
  }
  if (document.activeElement !== elTimeline) elTimeline.value = Math.min(t, T_MAX);
}

// ============================ BOUCLE ============================
function boucle(maintenant) {
  const delta = (maintenant - dernierT) / 1000;
  dernierT = maintenant;
  if (enLecture) {
    tSim += delta * vitesse;
    if (tSim > T_MAX) { tSim = T_MAX; basculerLecture(); }
  }
  const compteurs = dessiner(tSim);
  majHud(tSim, compteurs, maintenant);
  // FPS lissé
  const fps = 1 / Math.max(delta, 1e-4);
  fpsMoyen = fpsMoyen * 0.92 + fps * 0.08;
  elFps.textContent = Math.round(fpsMoyen) + " fps";
  requestAnimationFrame(boucle);
}

// ============================ CONTRÔLES ============================
function basculerLecture() {
  enLecture = !enLecture;
  btnPlay.textContent = enLecture ? "❚❚" : "▶";
}
btnPlay.addEventListener("click", basculerLecture);
elTimeline.addEventListener("input", () => { tSim = Number(elTimeline.value); dernierT = performance.now(); });
document.querySelectorAll(".vit").forEach(b => {
  b.addEventListener("click", () => {
    vitesse = Number(b.dataset.v);
    document.querySelectorAll(".vit").forEach(x => x.classList.toggle("actif", x === b));
  });
});

// zoom molette + pan souris
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const facteur = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  vueCarte.echelle *= facteur;
}, { passive: false });
let drag = null;
canvas.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY }; canvas.classList.add("drag"); });
addEventListener("pointermove", e => {
  if (!drag) return;
  vueCarte.cx -= (e.clientX - drag.x) / vueCarte.echelle;
  vueCarte.cy += (e.clientY - drag.y) / vueCarte.echelle;
  drag = { x: e.clientX, y: e.clientY };
});
addEventListener("pointerup", () => { drag = null; canvas.classList.remove("drag"); });

// raccourcis clavier
addEventListener("keydown", e => {
  if (e.code === "Space") { e.preventDefault(); basculerLecture(); }
});

// ============================ DÉPART ============================
document.getElementById("chargement").remove();
// export de test (lecture seule côté sonde jsdom) — inoffensif en production
window.__APP = {
  courses, ROUTES, STATS, DTS,
  get tSim() { return tSim; }, set tSim(v) { tSim = v; },
  dessiner: (t) => dessiner(t),
  // debug/QA : positions écran calculées par le code de production
  positions: (t) => {
    const res = [];
    const pos = { lat: 0, lon: 0 };
    for (const c of courses) {
      if (c.t0 > t) continue;
      if (t > c.t0 + c.span) continue;
      positionCourse(c, t, pos);
      const [hx, hy] = versEcran(mercX(pos.lon), mercY(pos.lat));
      res.push({ ref: c.ref, lat: pos.lat, lon: pos.lon, hx, hy, n: c.n, span: c.span });
    }
    return res;
  },
};
requestAnimationFrame(boucle);
