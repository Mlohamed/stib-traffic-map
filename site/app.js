
"use strict";
function initPage() {
// ============================ DONNÉES (injectées au build) ============================
const PAYLOAD = window.PAYLOAD;

// ============================ DÉCODAGE DU BINAIRE ============================
function binversBytes(x) { return x instanceof Uint8Array ? x : b64versBytes(x); }
function b64versBytes(b64) {
  const bin = atob(b64);
  const octets = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) octets[i] = bin.charCodeAt(i);
  return octets;
}

const entetes = {}, vues = {}, DTS = {};
for (const mode of Object.keys(PAYLOAD.bins)) {
  const u8 = binversBytes(PAYLOAD.bins[mode]);
  entetes[mode] = u8;
  vues[mode] = new DataView(u8.buffer);
  DTS[mode] = vues[mode].getUint16(10, true); // dt dans le header (self-describing)
}

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
    const span = vue.getUint16(base + (n - 1) * 10 + 8, true); // pas FIXE 10 o/point
    courses.push({ ref, t0, n, base, span, mode, DT: DTm });
    pos = base + n * 10;
  }
}
courses.sort((a, b) => a.t0 - b.t0);

const ROUTES = PAYLOAD.routes.routes;
const STATS = PAYLOAD.network;
const LIGNES = PAYLOAD.lines.features;

// ============================ PROJECTION ============================
function mercX(lon) { return lon * Math.PI / 180; }
function mercY(lat) { const r = lat * Math.PI / 180; return Math.log(Math.tan(Math.PI / 4 + r / 2)); }
let bxmin = Infinity, bxmax = -Infinity, bymin = Infinity, bymax = -Infinity;
for (const f of LIGNES) {
  for (const [lon, lat] of f.geometry.coordinates) {
    const x = mercX(lon), y = mercY(lat);
    if (x < bxmin) bxmin = x; if (x > bxmax) bxmax = x;
    if (y < bymin) bymin = y; if (y > bymax) bymax = y;
  }
}
const vueCarte = { cx: (bxmin + bxmax) / 2, cy: (bymin + bymax) / 2, echelle: 1 };
const MARGE = 90;
function echellePleine() {
  const ex = (bxmax - bxmin) || 1, ey = (bymax - bymin) || 1;
  return Math.min((innerWidth - 2 * MARGE) / ex, (innerHeight - 2 * MARGE) / ey);
}
function ajusterVue() {
  vueCarte.cx = (bxmin + bxmax) / 2; vueCarte.cy = (bymin + bymax) / 2;
  vueCarte.echelle = echellePleine();
}
function versEcran(x, y) {
  return [innerWidth / 2 + (x - vueCarte.cx) * vueCarte.echelle,
          innerHeight / 2 + (vueCarte.cy - y) * vueCarte.echelle];
}
function bboxDeRefs(refs) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const f of LIGNES) {
    if (!refs.includes(f.properties.ref)) continue;
    for (const [lon, lat] of f.geometry.coordinates) {
      const x = mercX(lon), y = mercY(lat);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return [x0, y0, x1, y1];
}
function camVers(bbox, zoom = 1, duree = 1800) {
  const [x0, y0, x1, y1] = bbox;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const echCible = Math.min((innerWidth - 2 * MARGE) / Math.max(x1 - x0, 1e-9),
                            (innerHeight - 2 * MARGE) / Math.max(y1 - y0, 1e-9)) * zoom;
  const dep = { cx: vueCarte.cx, cy: vueCarte.cy, ech: vueCarte.echelle };
  const t0 = performance.now();
  (function anime(now) {
    const w = Math.min((now - t0) / duree, 1);
    const e = 1 - Math.pow(1 - w, 3);
    vueCarte.cx = dep.cx + (mx - dep.cx) * e;
    vueCarte.cy = dep.cy + (my - dep.cy) * e;
    vueCarte.echelle = dep.ech + (echCible - dep.ech) * e;
    if (w < 1) requestAnimationFrame(anime);
  })(t0);
}
const refDe = new Map(ROUTES.map(r => [r.line, r.ref]));
const BBOX_METRO = bboxDeRefs(ROUTES.filter(r => r.mode === "metro").map(r => r.ref));
const BBOX_TRAM = bboxDeRefs(ROUTES.filter(r => r.mode === "tram").map(r => r.ref));
const BBOX_BOUCLE = bboxDeRefs([refDe.get("2"), refDe.get("6")].filter(r => r !== undefined));
const BBOX_L1L5 = bboxDeRefs([refDe.get("1"), refDe.get("5")].filter(r => r !== undefined));

// ============================ ÉTAT ============================
const paramT = new URLSearchParams(location.search).get("t");
let tSim = paramT ? Number(paramT) : 4.6 * 3600;
let vitesse = 300;
let enLecture = false;
let kiosque = false;
let etapeScenario = -1;
let dernierT = performance.now();
let fpsMoyen = 0;
const T_MAX = STATS.timeline_end_s;
const T_LOOP_DEBUT = 4 * 3600;
// hiérarchie visuelle : le métro domine, le tram suit, le bus tisse la trame de fond
const STYLE_MODE = {
  metro: { alphaLigne: 0.36, epLigne: 3.0, alphaHalo: 0.24, rTete: 4.4, rCoeur: 1.9, alphaTrail: 0.60, epTrail: 2.4 },
  tram:  { alphaLigne: 0.22, epLigne: 1.9, alphaHalo: 0.20, rTete: 3.6, rCoeur: 1.6, alphaTrail: 0.50, epTrail: 2.0 },
  bus:   { alphaLigne: 0.13, epLigne: 1.1, alphaHalo: 0.14, rTete: 2.7, rCoeur: 1.2, alphaTrail: 0.38, epTrail: 1.5 },
};
const modesActifs = new Set(["metro", "tram", "bus"]); // filtres légende

// ============================ CANVAS ============================
const canvas = document.getElementById("carte");
const ctxBrut = canvas.getContext ? canvas.getContext("2d") : null;
const ctx = ctxBrut || new Proxy({}, { get: () => () => {} });
function redimensionner() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = innerWidth + "px";
  canvas.style.height = innerHeight + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", redimensionner);
redimensionner();

// ============================ BADGES DE LIGNES (terminus) ============================
function joliNom(s) {
  if (!s) return "";
  const petits = new Set(["de", "du", "des", "la", "le", "l", "het", "den", "ter", "aan", "op"]);
  return s.toLowerCase().replace(/\(p\)/g, "").split(/([ \-'])/).map((w, i) =>
    petits.has(w) && i !== 0 ? w : (w.charAt(0).toUpperCase() + w.slice(1))
  ).join("").replace(/\s+/g, " ").trim();
}
const badges = [];
{
  const vu = new Map(); // ref -> feature (sens 0 de préférence)
  for (const f of LIGNES) {
    const r = f.properties.ref;
    if (!vu.has(r) || f.properties.direction === 0) vu.set(r, f);
  }
  for (const [ref, f] of vu) {
    const co = f.geometry.coordinates[f.geometry.coordinates.length - 1];
    const route = ROUTES[ref];
    badges.push({ ref, line: route.line, color: route.color, texte: route.text_color,
                  mode: route.mode,
                  terminus: joliNom(f.properties.terminus), mx: mercX(co[0]), my: mercY(co[1]) });
  }
}
badges.sort((a, b) => a.line.localeCompare(b.line, "fr", { numeric: true }));

// ============================ RENDU ============================
const TRAIL_S = 45;
function positionCourse(c, t, out) {
  let x = (t - c.t0) / c.DT;
  if (x < 0) x = 0;
  const iMax = c.n - 1;
  if (x > iMax) x = iMax;
  const i0 = Math.min(Math.floor(x), iMax - 1);
  const fr = x - i0;
  const b0 = c.base + i0 * 10, b1 = b0 + 10; // pas fixe 10 o
  const v = vues[c.mode];
  out.lat = v.getFloat32(b0, true) + fr * (v.getFloat32(b1, true) - v.getFloat32(b0, true));
  out.lon = v.getFloat32(b0 + 4, true) + fr * (v.getFloat32(b1 + 4, true) - v.getFloat32(b0 + 4, true));
  return out;
}
function dessiner(t) {
  const Wc = innerWidth, Hc = innerHeight;
  ctx.clearRect(0, 0, Wc, Hc);
  ctx.lineJoin = "round";
  if (!new URLSearchParams(location.search).has("nolines")) {
    for (const f of LIGNES) {
      const st = STYLE_MODE[f.properties.mode] || STYLE_MODE.bus;
      ctx.beginPath();
      let premier = true;
      for (const [lon, lat] of f.geometry.coordinates) {
        const [px, py] = versEcran(mercX(lon), mercY(lat));
        if (premier) { ctx.moveTo(px, py); premier = false; } else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = "#" + f.properties.color;
      ctx.globalAlpha = st.alphaLigne;
      ctx.lineWidth = st.epLigne;
      ctx.stroke();
      ctx.globalAlpha = st.alphaLigne * 0.28;
      ctx.lineWidth = st.epLigne * 2.4;
      ctx.stroke();
    }
  }
  // véhicules — dessin par couches de mode (métro au-dessus de tout)
  const ordre = ["bus", "tram", "metro"];
  const pos = { lat: 0, lon: 0 };
  let visibles = 0;
  const parLigne = new Array(ROUTES.length).fill(0);
  for (const mode of ordre) {
    if (!modesActifs.has(mode)) continue;
    const st = STYLE_MODE[mode];
    for (const c of courses) {
      if (c.mode !== mode) continue;
      if (c.t0 > t) continue;
      if (t > c.t0 + c.span) continue;
      visibles++;
      parLigne[c.ref]++;
      positionCourse(c, t, pos);
      const iActuel = Math.min(Math.floor((t - c.t0) / c.DT), c.n - 1);
      const iTrail = Math.max(0, Math.floor((t - TRAIL_S - c.t0) / c.DT));
      const v = vues[c.mode];
      ctx.beginPath();
      for (let i = iTrail; i <= iActuel; i++) {
        const b = c.base + i * 10;
        const [px, py] = versEcran(mercX(v.getFloat32(b + 4, true)), mercY(v.getFloat32(b, true)));
        if (i === iTrail) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      const [hx, hy] = versEcran(mercX(pos.lon), mercY(pos.lat));
      ctx.lineTo(hx, hy);
      ctx.strokeStyle = "#" + ROUTES[c.ref].color;
      ctx.globalAlpha = st.alphaTrail;
      ctx.lineWidth = st.epTrail;
      ctx.stroke();
      ctx.beginPath(); ctx.arc(hx, hy, st.rTete + 2.4, 0, 6.2832);
      ctx.fillStyle = "#" + ROUTES[c.ref].color; ctx.globalAlpha = st.alphaHalo; ctx.fill();
      ctx.beginPath(); ctx.arc(hx, hy, st.rTete, 0, 6.2832); ctx.globalAlpha = 0.95; ctx.fill();
      ctx.beginPath(); ctx.arc(hx, hy, st.rCoeur, 0, 6.2832); ctx.fillStyle = "#fff"; ctx.fill();
    }
  }
  // badges de lignes + terminus — visibilité selon modes actifs et zoom
  const echPleine = echellePleine();
  for (const b of badges) {
    if (!modesActifs.has(b.mode)) continue;
    const [px, py] = versEcran(b.mx, b.my);
    if (px < -40 || px > Wc + 40 || py < -20 || py > Hc + 20) continue;
    // hiérarchie : métro toujours, tram dès 60 %, bus seulement en zoom
    const seuil = b.mode === "metro" ? 0 : b.mode === "tram" ? 0.6 : 1.15;
    if (vueCarte.echelle / echPleine < seuil) continue;
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = "#" + b.color;
    const w = Math.max(20, 8 + b.line.length * 8);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(px - w / 2, py - 8, w, 16, 3) : ctx.rect(px - w / 2, py - 8, w, 16);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#" + b.texte;
    ctx.font = "700 10px 'Segoe UI', sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(b.line, px, py + 0.5);
    if (vueCarte.echelle > echPleine * 1.05) {
      ctx.font = "600 10px 'Segoe UI', sans-serif";
      ctx.fillStyle = "rgba(238,241,246,0.88)";
      ctx.textAlign = "left";
      ctx.fillText(b.terminus, px + w / 2 + 6, py + 0.5);
    }
  }
  ctx.globalAlpha = 1;
  return { visibles, parLigne };
}

// ============================ HUD ============================
const elHorloge = document.getElementById("horloge");
const elKpiVeh = document.getElementById("kpi-veh");
const elKpiPic = document.getElementById("kpi-arr");
const elLegende = document.getElementById("legende");
const elStats = document.getElementById("phase-journee");
const elFps = document.getElementById("fps");
const elTimeline = document.getElementById("timeline");
const elDate = document.getElementById("badge-edition");
const btnPlay = document.getElementById("btn-play");
const elBadgeKiosque = document.getElementById("badge-kiosque");

function hhmm(t) {
  t = ((t % 86400) + 86400) % 86400;
  return String(Math.floor(t / 3600)).padStart(2, "0") + ":" + String(Math.floor((t % 3600) / 60)).padStart(2, "0");
}
function phaseJournee(t) {
  const h = (t % 86400) / 3600;
  if (h < 5.5) return "Service nocturne — les premières rames sortent";
  if (h < 6.5) return "Réveil du réseau — montée en cadence";
  if (h < 9) return "Heure de pointe du matin · ochtendspits";
  if (h < 11.5) return "Régime de croisière";
  if (h < 14) return "Milieu de journée — cadence soutenue";
  if (h < 16.5) return "Après-midi — le tram prend le relais";
  if (h < 19) return "Heure de pointe du soir · avondspits";
  if (h < 22) return "Soirée — respiration du réseau";
  return "Fin de service — retour au dépôt";
}
{ // légende à onglets par mode, badge numéro + compteur live
  const titres = { metro: "Métro", tram: "Tram", bus: "Bus" };
  const elOnglets = document.getElementById("onglets");
  const parMode = {};
  for (const r of ROUTES) (parMode[r.mode] = parMode[r.mode] || []).push(r);

  function dessinerOnglets() {
    elOnglets.innerHTML = "";
    for (const m of Object.keys(titres)) {
      if (!parMode[m]) continue;
      const b = document.createElement("div");
      b.className = "onglet" + (modesActifs.size === 1 && modesActifs.has(m) ? " actif" : "");
      const nbVeh = courses.filter(c => c.mode === m).length;
      b.innerHTML = `${titres[m]}<span class="n">${parMode[m].length} lignes</span>`;
      b.title = `${titres[m]} : ${nbVeh.toLocaleString("fr-BE")} courses/jour — cliquer pour isoler`;
      b.addEventListener("click", () => {
        // bascule : si le mode est le seul actif, tout réafficher ; sinon isoler
        if (modesActifs.size === 1 && modesActifs.has(m)) {
          modesActifs.clear();
          Object.keys(titres).forEach(x => modesActifs.add(x));
        } else {
          modesActifs.clear();
          modesActifs.add(m);
        }
        dessinerOnglets();
        majVisibiliteLegende();
      });
      elOnglets.appendChild(b);
    }
  }
  window.__ONGLETS = dessinerOnglets;

  function majVisibiliteLegende() {
    for (const r of ROUTES) {
      const el = document.getElementById("li-" + r.ref);
      if (el) el.style.display = modesActifs.has(r.mode) ? "" : "none";
    }
  }
  window.__VISIBILITE = majVisibiliteLegende;

  let dernierMode = null;
  for (const r of ROUTES) {
    if (r.mode !== dernierMode) {
      dernierMode = r.mode;
      const h = document.createElement("div");
      h.className = "titre-mode";
      h.textContent = titres[r.mode] || r.mode;
      h.dataset.mode = r.mode;
      elLegende.appendChild(h);
    }
    const div = document.createElement("div");
    div.className = "ligne-item";
    div.id = "li-" + r.ref;
    div.title = joliNom(r.long_name);
    // innerHTML sûr : données générées par le pipeline (couleur 6-hex, numéro de ligne)
    div.innerHTML = `<span class="num-badge" style="background:#${r.color};color:#${r.text_color}">${r.line}</span>
                     <span class="nb" id="nb-l${r.ref}">0</span>`;
    div.addEventListener("click", () => { quitterKiosque(); zoomLigne(r.ref); marquerZoom(r.ref); });
    elLegende.appendChild(div);
  }
  dessinerOnglets();
}
function marquerZoom(ref) {
  document.querySelectorAll(".ligne-item").forEach(el => el.classList.remove("zoom-on"));
  const el = document.getElementById("li-" + ref);
  if (el) el.classList.add("zoom-on");
}
const d = STATS.date;
elDate.textContent = `Simulation · mercredi ${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)} · horaires théoriques`;

let zoomActif = null;
function zoomLigne(ref) {
  if (zoomActif === ref) { zoomActif = null; camVers([bxmin, bymin, bxmax, bymax], 1); return; }
  zoomActif = ref;
  camVers(bboxDeRefs([ref]), 1.02);
}

let dernierHud = 0;
function majHud(t, compteurs, maintenant) {
  if (maintenant - dernierHud < 180) return;
  dernierHud = maintenant;
  const j1 = t >= 86400;
  elHorloge.innerHTML = hhmm(t) + (j1 ? '<span class="j1">J+1</span>' : "");
  elStats.textContent = phaseJournee(t);
  elKpiVeh.textContent = compteurs ? compteurs.visibles : 0;
  elKpiPic.textContent = STATS.combined.peak_time;
  if (compteurs) {
    for (let r = 0; r < ROUTES.length; r++) {
      const el = document.getElementById("nb-l" + r);
      if (el) el.textContent = compteurs.parLigne[r];
    }
  }
  if (document.activeElement !== elTimeline) elTimeline.value = Math.min(t, T_MAX);
}

// ============================ SCÉNARIO PRÉSENTATION ============================
const SCENARIO = [
  { until: 5.55 * 3600, speed: 900,  cam: null,            zoom: 1 },     // aube, réseau entier
  { until: 6.95 * 3600, speed: 900,  cam: BBOX_L1L5,       zoom: 1.05 },  // approche métro est-ouest
  { until: 7.7  * 3600, speed: 260,  cam: BBOX_BOUCLE,     zoom: 1.25 },  // pointe 07:07 sur la boucle
  { until: 9.6  * 3600, speed: 600,  cam: null,            zoom: 1 },     // pleine amplitude
  { until: 12.6 * 3600, speed: 900,  cam: BBOX_TRAM,       zoom: 1.02 },  // maillage tram
  { until: 17   * 3600, speed: 600,  cam: null,            zoom: 1 },     // pic tram 16:11
  { until: 19.6 * 3600, speed: 260,  cam: BBOX_BOUCLE,     zoom: 1.25 },  // pointe du soir
  { until: 25   * 3600, speed: 1200, cam: null,            zoom: 1 },     // soirée accélérée
];
function appliquerEtape(i) {
  const e = SCENARIO[i];
  vitesse = e.speed;
  document.querySelectorAll(".vit").forEach(x => x.classList.toggle("actif", +x.dataset.v === e.speed));
  if (e.cam) camVers(e.cam, e.zoom); else camVers([bxmin, bymin, bxmax, bymax], 1);
}
function demarrerKiosque() {
  kiosque = true;
  enLecture = true;
  btnPlay.textContent = "❚❚";
  tSim = T_LOOP_DEBUT;
  etapeScenario = 0;
  appliquerEtape(0);
  elBadgeKiosque.style.display = "block";
  document.body.style.cursor = "none";
}
function quitterKiosque() {
  if (!kiosque) return;
  kiosque = false;
  etapeScenario = -1;
  elBadgeKiosque.style.display = "none";
  document.body.style.cursor = "";
  vitesse = 300;
  document.querySelectorAll(".vit").forEach(x => x.classList.toggle("actif", +x.dataset.v === 300));
}
function piloterScenario() {
  if (!kiosque) return;
  if (tSim >= T_MAX - 60) { tSim = T_LOOP_DEBUT; etapeScenario = 0; appliquerEtape(0); return; }
  const cible = SCENARIO.findIndex(e => tSim < e.until);
  const i = cible === -1 ? SCENARIO.length - 1 : cible;
  if (i !== etapeScenario) { etapeScenario = i; appliquerEtape(i); }
}

// ============================ BOUCLE ============================
function boucle(maintenant) {
  const delta = (maintenant - dernierT) / 1000;
  dernierT = maintenant;
  if (enLecture) {
    tSim += delta * vitesse;
    if (!kiosque && tSim > T_MAX) { tSim = T_MAX; basculerLecture(); }
    if (kiosque) piloterScenario();
  }
  const compteurs = dessiner(tSim);
  majHud(tSim, compteurs, maintenant);
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
btnPlay.addEventListener("click", () => { quitterKiosque(); basculerLecture(); });
elTimeline.addEventListener("input", () => { quitterKiosque(); tSim = Number(elTimeline.value); dernierT = performance.now(); });
document.querySelectorAll(".vit").forEach(b => {
  b.addEventListener("click", () => {
    quitterKiosque();
    vitesse = Number(b.dataset.v);
    document.querySelectorAll(".vit").forEach(x => x.classList.toggle("actif", x === b));
  });
});
document.getElementById("btn-kiosque").addEventListener("click", demarrerKiosque);
canvas.addEventListener("wheel", e => {
  e.preventDefault(); quitterKiosque();
  vueCarte.echelle *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
}, { passive: false });
let drag = null;
canvas.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY }; canvas.classList.add("drag"); });
addEventListener("pointermove", e => {
  if (!drag) return;
  quitterKiosque();
  vueCarte.cx -= (e.clientX - drag.x) / vueCarte.echelle;
  vueCarte.cy += (e.clientY - drag.y) / vueCarte.echelle;
  drag = { x: e.clientX, y: e.clientY };
});
addEventListener("pointerup", () => { drag = null; canvas.classList.remove("drag"); });
addEventListener("keydown", e => {
  if (e.code === "Space") { e.preventDefault(); quitterKiosque(); basculerLecture(); }
  if (e.code === "Escape") quitterKiosque();
});

// ============================ SPLASH ============================
function compterJusque(el, cible, duree = 1300) {
  const t0 = performance.now();
  (function anime(now) {
    const w = Math.min((now - t0) / duree, 1);
    const e = 1 - Math.pow(1 - w, 3);
    el.textContent = Math.round(cible * e).toLocaleString("fr-BE");
    if (w < 1) requestAnimationFrame(anime);
  })(t0);
}
{
  const totalPoints = courses.reduce((s, c) => s + c.n, 0);
  const modes = { metro: 0, tram: 0, bus: 0 };
  for (const c of courses) modes[c.mode]++;
  const elModes = document.getElementById("sp-modes");
  if (elModes) elModes.textContent =
    `Métro ${modes.metro.toLocaleString("fr-BE")} · Tram ${modes.tram.toLocaleString("fr-BE")} · Bus ${modes.bus.toLocaleString("fr-BE")}`;
  compterJusque(document.getElementById("sp-courses"), STATS.trips_total);
  compterJusque(document.getElementById("sp-lignes"), STATS.routes_count, 700);
  compterJusque(document.getElementById("sp-pic"), STATS.combined.peak_simultaneous, 900);
  compterJusque(document.getElementById("sp-points"), totalPoints, 1500);
}
function partirSplash(kiosk) {
  const sp = document.getElementById("splash");
  sp.classList.add("parti");
  setTimeout(() => sp.remove(), 1200);
  enLecture = true;
  btnPlay.textContent = "❚❚";
  if (kiosk) demarrerKiosque();
  else { vitesse = 300; ajusterVue(); }
}
document.getElementById("btn-libre").addEventListener("click", () => partirSplash(false));
document.getElementById("btn-kiosk-plein").addEventListener("click", () => partirSplash(true));

// ============================ EXPORT TEST + DÉPART ============================
window.__APP = {
  courses, ROUTES, STATS, DTS, SCENARIO, badges, modesActifs,
  get tSim() { return tSim; }, set tSim(v) { tSim = v; },
  dessiner: (t) => dessiner(t),
  positions: (t) => {
    const res = []; const pos = { lat: 0, lon: 0 };
    for (const c of courses) {
      if (!modesActifs.has(c.mode)) continue;
      if (c.t0 > t || t > c.t0 + c.span) continue;
      positionCourse(c, t, pos);
      const [hx, hy] = versEcran(mercX(pos.lon), mercY(pos.lat));
      res.push({ ref: c.ref, mode: c.mode, lat: pos.lat, lon: pos.lon, hx, hy });
    }
    return res;
  },
  get kiosque() { return kiosque; },
};
redimensionner();
ajusterVue();
if (new URLSearchParams(location.search).has("kiosk")) {
  document.getElementById("splash").remove();
  demarrerKiosque();
} else if (paramT) {
  document.getElementById("splash").remove();
  enLecture = false;
  btnPlay.textContent = "▶";
  tSim = Number(paramT);
} else {
  ajusterVue();
}
requestAnimationFrame(boucle);
}
// laisse le splash s'afficher avant le décodage (13 Mo de base64 bloquent ~1,5 s)
setTimeout(initPage, 40);
