/**
 * Sonde DOM édition UITP — vérifie décodage, positions écran, badges terminus,
 * scénario kiosque. Usage : node app/verifier_uitp.js (exit 0 = OK)
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "app", "index_uitp.html"), "utf-8");
const vc = new VirtualConsole();
vc.on("jsdomError", () => {}); // canvas absent de jsdom — attendu

const SONDE = `
<script>
window.__d = { erreur: null, ok: false };
(function attendre() {
  if (!window.__APP) { setTimeout(attendre, 200); return; }
  try {
  const A = window.__APP;
  const fails = [];
  window.__d.nbCourses = A.courses.length;
  window.__d.nbRoutes = A.ROUTES.length;
  window.__d.nbBadges = A.badges.length;
  if (A.courses.length !== 7584) fails.push("courses " + A.courses.length + " != 7584");
  if (A.ROUTES.length !== 22) fails.push("routes != 22");
  if (A.badges.length < 20) fails.push("badges terminus " + A.badges.length + " < 20");

  for (const [t, min] of [[25580, 150], [58260, 220], [88200, 5]]) {
    const ps = A.positions(t);
    const finies = ps.filter(p => Number.isFinite(p.hx) && Number.isFinite(p.hy)).length;
    if (finies < min) fails.push("t=" + t + " : " + finies + " < " + min);
    if (finies !== ps.length) fails.push("t=" + t + " : NaN restants");
    window.__d["t" + t] = finies + "/" + ps.length;
  }

  if (A.SCENARIO.length !== 8) fails.push("scénario != 8 étapes");

  A.dessiner(25580);
  window.__d.ok = fails.length === 0;
  window.__d.fails = fails;
  } catch (e) { window.__d.erreur = e.message; }
})();
</script>`;

const dom = new JSDOM(html + "\n" + SONDE + "\n", {
  runScripts: "dangerously", pretendToBeVisual: true,
  url: "https://local/", virtualConsole: vc,
});
function attendreApp(tentative) {
  if (tentative > 40) { console.log("KO : __APP jamais exposé"); process.exit(1); }
  if (!dom.window.__APP) { setTimeout(() => attendreApp(tentative + 1), 250); return; }
  setTimeout(() => {
  const d = dom.window.__d;
  if (d.erreur) { console.log("KO exception:", d.erreur); process.exit(1); }
  console.log(`OK  ${d.nbCourses} courses, ${d.nbRoutes} lignes, ${d.nbBadges} badges terminus`);
  console.log(`OK  positions : 07:07 ${d.t25580} · 16:11 ${d.t58260} · 00:30 ${d.t88200}`);
  let ko = false;
  if (d.fails && d.fails.length) { ko = true; d.fails.forEach(f => console.log("KO " + f)); }
  console.log(ko ? "\nRÉSULTAT : ÉCHEC" : "\nRÉSULTAT : CONFORME");
  process.exit(ko ? 1 : 0);
  }, 50);
}
attendreApp(0);
