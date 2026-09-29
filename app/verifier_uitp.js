/**
 * Sonde DOM édition UITP — vérifie décodage, positions écran, badges terminus,
 * scénario kiosque + fonctionnalités v2 « legendary » (index temporel, arrêts,
 * pulses métro, suivi véhicule, profil horaire, heatmap, ambiance, mentions légales).
 * Usage : node app/verifier_uitp.js (exit 0 = OK)
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "app", "index_uitp.html"), "utf-8");
// référence données : les 92 lignes (numéro + couleurs) doivent être celles du build GTFS
const ROUTES_REF = JSON.parse(fs.readFileSync(path.join(ROOT, "data_out", "routes.json"), "utf-8")).routes;
const vc = new VirtualConsole();
vc.on("jsdomError", () => {}); // canvas absent de jsdom — attendu

const SONDE = `
<script>
window.__d = { erreur: null, ok: false };
window.__ROUTES_REF = ${JSON.stringify(ROUTES_REF.map(r => [r.ref, r.line, r.color, r.text_color, r.mode]))};
(function attendre() {
  if (!window.__APP) { setTimeout(attendre, 200); return; }
  try {
  const A = window.__APP;
  const fails = [];
  const D = window.__d;
  D.nbCourses = A.courses.length;
  D.nbRoutes = A.ROUTES.length;
  D.nbBadges = A.badges.length;
  D.nbBus = A.courses.filter(c => c.mode === "bus").length;
  if (A.courses.length !== 18731) fails.push("courses " + A.courses.length + " != 18731");
  if (A.ROUTES.length !== 92) fails.push("routes " + A.ROUTES.length + " != 92");
  if (D.nbBus !== 11147) fails.push("bus " + D.nbBus + " != 11147"); // (v1 : test inopérant, A.nbBus jamais défini)
  if (A.badges.length < 70) fails.push("badges terminus " + A.badges.length + " < 70");
  // lignes intactes : numéro, couleurs, mode identiques au build GTFS
  const diff = window.__ROUTES_REF.filter(([ref, l, c, tc, m]) => {
    const r = A.ROUTES[ref]; return !r || r.line !== l || r.color !== c || r.text_color !== tc || r.mode !== m; });
  if (diff.length) fails.push("lignes modifiées : " + diff.map(x => x[1]).join(","));

  // positions finies à 3 instants clés (seuils réseau complet mesurés au build)
  for (const [t, min] of [[25580, 500], [58260, 700], [88200, 100]]) {
    const ps = A.positions(t);
    const finies = ps.filter(p => Number.isFinite(p.hx) && Number.isFinite(p.hy)).length;
    if (finies < min) fails.push("t=" + t + " : " + finies + " < " + min);
    if (finies !== ps.length) fails.push("t=" + t + " : NaN restants");
    D["t" + t] = finies + "/" + ps.length;
  }
  if (A.SCENARIO.length !== 8) fails.push("scénario != 8 étapes");

  // ---------- v2 : index temporel == force brute, à 12 instants ----------
  let ecarts = 0;
  for (let t = 16000; t <= 90000; t += 6500) {
    const brut = A.courses.filter(c => c.t0 <= t && t <= c.t0 + c.span).length;
    if (A.dessiner(t).visibles !== brut) ecarts++;
  }
  D.pic = A.dessiner(61380).visibles;
  D.candPic = A.candidats(61380);
  if (ecarts) fails.push("index temporel : " + ecarts + " instants divergent de la force brute");
  if (D.candPic > 3000) fails.push("index : " + D.candPic + " candidats au pic (> 3000, index inefficace)");

  // ---------- v2 : arrêts, stations, pulses ----------
  D.arrets = A.ARRETS; D.stations = A.STATIONS.length; D.passages = A.PASSAGES;
  if (A.ARRETS < 2000) fails.push("arrêts " + A.ARRETS + " < 2000 (stops.json absent ?)");
  if (A.STATIONS.length < 50 || A.STATIONS.length > 80) fails.push("stations métro " + A.STATIONS.length + " hors [50,80]");
  if (A.PASSAGES < 20000) fails.push("passages métro en station " + A.PASSAGES + " < 20000");
  D.pulses = A.stationsDesservies(61380, 120);
  if (D.pulses < 10) fails.push("pulses stations à 17:03 (2 min) : " + D.pulses + " < 10");

  // ---------- v2 : profil horaire ----------
  let mx = 0, mArg = 0; A.PROFIL.forEach((v, m) => { if (v > mx) { mx = v; mArg = m; } });
  const hh = String(Math.floor(mArg / 60)).padStart(2, "0") + ":" + String(mArg % 60).padStart(2, "0");
  D.profil = mx + " @ " + hh;
  if (mx !== A.STATS.combined.peak_simultaneous || hh !== A.STATS.combined.peak_time)
    fails.push("profil : pic " + mx + " @ " + hh + " ≠ network.json " + A.STATS.combined.peak_simultaneous + " @ " + A.STATS.combined.peak_time);
  if (A.PICS.length !== 3) fails.push("pics annotés != 3");
  D.pics = A.PICS.map(p => p.lib + " " + p.n).join(" · ");

  // ---------- v2 : suivi véhicule ----------
  const inf = A.suivreAuto(61380, "metro");
  if (!inf) fails.push("suivi : aucun métro suivable à 17:03");
  else {
    D.suivi = "ligne " + inf.ligne + " → " + inf.terminus + ", prochain " + inf.prochain + ", " + inf.restants + "/" + inf.nbArrets;
    if (inf.mode !== "metro") fails.push("suivi : mode " + inf.mode);
    if (!inf.prochain || inf.prochain === "—") fails.push("suivi : prochain arrêt vide");
    if (inf.eta < 61380) fails.push("suivi : ETA dans le passé");
    if (inf.nbArrets < 5) fails.push("suivi : " + inf.nbArrets + " arrêts reconnus sur la course");
    if (!document.getElementById("suivi").classList.contains("on")) fails.push("suivi : carte non affichée");
    const c = A.suivi, arr = c.arrets;
    if (arr.some((s, j) => j && s.i < arr[j - 1].i)) fails.push("suivi : arrêts non ordonnés");
    if (inf.eta > c.t0 + c.span + 1) fails.push("suivi : ETA après le terminus");
    A.suivre(null);
    if (A.suivi) fails.push("suivi : sortie impossible");
  }
  // clic → véhicule : la tête projetée d'une course doit être retrouvée sous le pointeur
  A.dessiner(61380);
  const p0 = A.positions(61380).find(p => p.mode === "metro");
  if (!p0 || !A.vehiculeSous(p0.hx, p0.hy)) fails.push("clic : aucun véhicule détecté sous une tête de métro");

  // ---------- v2 : heatmap ----------
  const hm = A.heatmapTop(61380);
  D.heat = hm.top.map(p => p.nom + " " + p.vph + "/h").join(" · ") + " (construction " + Math.round(hm.ms) + " ms)";
  if (hm.top.length !== 3 || hm.top.some(p => !(p.vph > 0))) fails.push("heatmap : top 3 invalide");
  if (!A.basculerHeatmap(true) || A.basculerHeatmap(false)) fails.push("heatmap : bascule H");

  // ---------- v2 : ambiance jour/nuit ----------
  const lum = a => a.fond.reduce((s, v) => s + v, 0);
  if (!(lum(A.ambiance(13 * 3600)) > lum(A.ambiance(3 * 3600)))) fails.push("ambiance : midi pas plus clair que 03:00");

  // ---------- mentions obligatoires ----------
  const attr = document.getElementById("attribution").textContent;
  if (!/NON AFFILIÉE À LA STIB-MIVB/.test(attr)) fails.push("mention « non affiliée » absente");
  if (!/CC BY 4\\.0/.test(attr)) fails.push("attribution CC BY 4.0 absente");

  A.dessiner(25580);
  D.ok = fails.length === 0;
  D.fails = fails;
  } catch (e) { window.__d.erreur = e.message + " " + (e.stack || "").split("\\n")[1]; }
})();
</script>`;

const dom = new JSDOM(html + "\n" + SONDE + "\n", {
  runScripts: "dangerously", pretendToBeVisual: true,
  url: "https://local/", virtualConsole: vc,
});
function attendreApp(tentative) {
  if (tentative > 80) { console.log("KO : __APP jamais exposé / sonde inachevée"); process.exit(1); }
  const d = dom.window.__d;
  if (!dom.window.__APP || !d || (d.fails === undefined && !d.erreur)) {
    setTimeout(() => attendreApp(tentative + 1), 250); return;
  }
  if (d.erreur) { console.log("KO exception:", d.erreur); process.exit(1); }
  console.log(`OK  ${d.nbCourses} courses (${d.nbBus} bus), ${d.nbRoutes} lignes, ${d.nbBadges} badges terminus`);
  console.log(`OK  positions : 07:07 ${d.t25580} · 16:11 ${d.t58260} · 00:30 ${d.t88200}`);
  console.log(`    index temporel : ${d.pic} véhicules au pic, ${d.candPic} candidats visités (sur 18 731)`);
  console.log(`    arrêts ${d.arrets} · stations métro ${d.stations} · passages en station ${d.passages} · pulses 17:01-17:03 ${d.pulses}`);
  console.log(`    profil : pic ${d.profil} · ${d.pics}`);
  console.log(`    suivi : ${d.suivi}`);
  console.log(`    heatmap 17:03 : ${d.heat}`);
  let ko = false;
  if (d.fails && d.fails.length) { ko = true; d.fails.forEach(f => console.log("KO " + f)); }
  console.log(ko ? "\nRÉSULTAT : ÉCHEC" : "\nRÉSULTAT : CONFORME");
  process.exit(ko ? 1 : 0);
}
attendreApp(0);
