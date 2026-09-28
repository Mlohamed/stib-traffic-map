/**
 * Diagnostic ciblé : les positions calculées par le code de production
 * (__APP.positions) sont-elles dans l'écran ? Compare aussi un échantillon
 * binaire lu côté JS vs valeurs attendues.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "app", "index.html"), "utf-8");

const vc = new VirtualConsole();
vc.on("jsdomError", (e) => console.log("JSDOM:", e.message));

const SONDE = `
<script>
window.__d = { erreur: null };
try {
  const A = window.__APP;
  if (!A) throw new Error("__APP absent");
  const T = 25580;
  const ps = A.positions(T);
  window.__d.nb = ps.length;
  window.__d.echantillon = ps.slice(0, 4);
  const hx = ps.map(p => p.hx), hy = ps.map(p => p.hy);
  window.__d.bornes = {
    hxMin: Math.min(...hx), hxMax: Math.max(...hx),
    hyMin: Math.min(...hy), hyMax: Math.max(...hy),
  };
  window.__d.dansEcran = ps.filter(p => p.hx >= 0 && p.hx <= 1600 && p.hy >= 0 && p.hy <= 900).length;
  window.__d.latlon = ps.slice(0, 3).map(p => [p.lat, p.lon]);
} catch (e) {
  window.__d.erreur = e.message + "\\n" + (e.stack || "").split("\\n").slice(0, 3).join("\\n");
}
</script>`;

const dom = new JSDOM(html + "\n" + SONDE + "\n", {
  runScripts: "dangerously", pretendToBeVisual: true,
  url: "https://local/?t=25580&pause=1", virtualConsole: vc,
});

setTimeout(() => {
  const d = dom.window.__d;
  if (d.erreur) { console.log("ERREUR:", d.erreur); process.exit(1); }
  console.log(`positions(t=07:06:20) : ${d.nb} véhicules`);
  console.log(`dans l'écran 1600x900 : ${d.dansEcran}`);
  console.log(`bornes hx [${d.bornes.hxMin.toFixed(0)} ; ${d.bornes.hxMax.toFixed(0)}]  hy [${d.bornes.hyMin.toFixed(0)} ; ${d.bornes.hyMax.toFixed(0)}]`);
  for (const e of d.echantillon) {
    console.log(`  ref=${e.ref} lat=${e.lat.toFixed(5)} lon=${e.lon.toFixed(5)} -> écran (${e.hx.toFixed(0)}, ${e.hy.toFixed(0)}) [n=${e.n} span=${e.span}]`);
  }
  console.log("lat/lon échantillon:", JSON.stringify(d.latlon));
}, 400);
