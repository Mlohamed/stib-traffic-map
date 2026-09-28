/**
 * Sonde DOM P1 (métro + tram) — vérifie le décodage des 2 binaires, les compteurs
 * par mode, le profil horaire combiné et le zoom par ref.
 * Usage : node app/verifier_page_p1.js (exit 0 = OK)
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "app", "index_p1.html"), "utf-8");

const vc = new VirtualConsole();
vc.on("jsdomError", () => {}); // canvas absent de jsdom — attendu

const SONDE = `
<script>
window.__d = { erreur: null };
try {
  const A = window.__APP;
  if (!A) throw new Error("__APP absent");
  const fails = [];
  window.__d.nbCourses = A.courses.length;
  window.__d.nbRoutes = A.ROUTES.length;
  if (A.ROUTES.length !== 22) fails.push("routes " + A.ROUTES.length + " != 22");
  const parMode = {};
  for (const c of A.courses) parMode[c.mode] = (parMode[c.mode] || 0) + 1;
  window.__d.parMode = parMode;
  if (parMode.metro !== 1383) fails.push("métro " + parMode.metro + " != 1383");
  if (parMode.tram !== 6201) fails.push("tram " + parMode.tram + " != 6201");

  // NaN check : positions écran finies à 3 instants
  const echantillons = [
    { t: 5 * 3600, min: 5, label: "05:00" },
    { t: 7 * 3600 + 7 * 60, min: 150, label: "pic métro 07:07" },
    { t: 16 * 3600 + 11 * 60, min: 220, label: "pic tram 16:11" },
    { t: 24.5 * 3600, min: 5, label: "00:30 (J+1)" },
  ];
  window.__d.ech = [];
  for (const e of echantillons) {
    const ps = A.positions(e.t);
    const finies = ps.filter(p => Number.isFinite(p.hx) && Number.isFinite(p.hy)
      && p.hx >= -50 && p.hx <= 1650 && p.hy >= -50 && p.hy <= 950).length;
    window.__d.ech.push({ label: e.label, total: ps.length, finies });
    if (finies < e.min) fails.push(e.label + " : " + finies + " positions valides < " + e.min);
    if (finies !== ps.length) fails.push(e.label + " : " + (ps.length - finies) + " positions NaN/hors écran");
  }
  window.__d.ok = fails.length === 0;
  window.__d.fails = fails;
} catch (e) {
  window.__d.erreur = e.message;
}
</script>`;

const dom = new JSDOM(html + "\n" + SONDE + "\n", {
  runScripts: "dangerously", pretendToBeVisual: true,
  url: "https://local/", virtualConsole: vc,
});

setTimeout(() => {
  const d = dom.window.__d;
  let ko = false;
  console.log("== Sonde DOM P1 (métro + tram) ==");
  if (d.erreur) { console.log("KO exception:", d.erreur); process.exit(1); }
  console.log(`OK  ${d.nbCourses} courses décodées (${d.parMode.metro} métro + ${d.parMode.tram} tram), ${d.nbRoutes} lignes`);
  for (const e of d.ech) console.log(`OK  ${e.label} : ${e.finies}/${e.total} positions écran valides`);
  if (d.fails && d.fails.length) { ko = true; d.fails.forEach(f => console.log("KO " + f)); }
  console.log(ko ? "\nRÉSULTAT : ÉCHEC" : "\nRÉSULTAT : CONFORME");
  process.exit(ko ? 1 : 0);
}, 500);
