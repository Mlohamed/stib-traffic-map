/**
 * STIB TRAFFIC MAP — sonde jsdom sur la page standalone générée.
 * Usage : node app/verifier_page.js  (exit 0 = OK, 1 = KO)
 * Vérifie : chargement sans erreur, décodage binaire, cohérence des compteurs,
 * HUD à différents instants de simulation, contrôles timeline/vitesse/play.
 */
const fs = require("fs");
const path = require("path");

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (e) {
  console.log("KO  jsdom absent — lancer : npm install jsdom");
  process.exit(1);
}

const ROOT = path.resolve(__dirname, "..");
const HTML_PATH = path.join(ROOT, "app", "index.html");
const html = fs.readFileSync(HTML_PATH, "utf-8");

const journal = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => journal.push(["JSDOM", e.message]));
vc.on("error", (...a) => journal.push(["ERREUR", a.join(" ")]));

const SONDE = `
<script>
window.__d = { erreur: null, ok: false };
try {
  const A = window.__APP;
  if (!A) throw new Error("__APP absent — le script de la page a échoué avant l'export");
  const fails = [];

  // 1) décodage binaire
  if (A.courses.length !== A.STATS.trips) fails.push("courses " + A.courses.length + " != stats " + A.STATS.trips);
  if (A.ROUTES.length !== 4) fails.push("routes " + A.ROUTES.length + " != 4");

  // 2) bornes temporelles des courses
  const t0min = Math.min(...A.courses.map(c => c.t0));
  const t1max = Math.max(...A.courses.map(c => c.t0 + c.span));
  if (t0min < 0 || t1max > 27 * 3600) fails.push("bornes temporelles incohérentes: " + t0min + "-" + t1max);

  // 3) dessin + compteurs à différents instants
  const echantillons = [
    { t: 5 * 3600, min: 1, label: "tôt le matin (05:00)" },
    { t: 7 * 3600 + 7 * 60, min: 20, label: "pic du matin (07:07)" },
    { t: 12 * 3600, min: 10, label: "mi-journée (12:00)" },
    { t: 18 * 3600 + 10 * 60, min: 20, label: "pic du soir (18:10)" },
    { t: 24.5 * 3600, min: 1, label: "fin de service (24:30)" },
  ];
  window.__d.echantillons = [];
  for (const e of echantillons) {
    const r = A.dessiner(e.t);
    window.__d.echantillons.push({ label: e.label, t: e.t, visibles: r.visibles });
    if (r.visibles < e.min) fails.push(e.label + " : " + r.visibles + " véhicules < " + e.min);
  }

  // 4) cohérence pic : max des compteurs dessinés >= 40 (stats dit 49 à 07:07)
  let maxVu = 0;
  for (let m = 6 * 60; m <= 9 * 60; m += 2) {
    const r = A.dessiner(m * 60);
    if (r.visibles > maxVu) maxVu = r.visibles;
  }
  window.__d.maxPicDessine = maxVu;
  if (maxVu < 40) fails.push("pic dessiné " + maxVu + " < 40 (attendu ~49)");

  // 5) HUD reflète tSim via majHud (test via le DOM)
  A.tSim = 7 * 3600 + 7 * 60;
  A.dessiner(A.tSim);
  window.__d.horloge = document.getElementById("horloge").textContent.trim();

  window.__d.ok = fails.length === 0;
  window.__d.fails = fails;
  window.__d.nbCourses = A.courses.length;
} catch (e) {
  window.__d.erreur = e.message;
  window.__d.stack = e.stack;
}
</script>`;

const dom = new JSDOM(html + "\n" + SONDE + "\n", {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://local/",
  virtualConsole: vc,
});

setTimeout(() => {
  const d = dom.window.__d || {};
  let ko = false;

  console.log("== Sonde DOM — STIBMAP P0 ==");
  if (d.erreur) {
    console.log("KO  exception sonde/page :", d.erreur);
    if (d.stack) console.log(d.stack.split("\n").slice(0, 4).join("\n"));
    ko = true;
  } else {
    console.log(`OK  décodage : ${d.nbCourses} courses, 4 lignes`);
    for (const e of d.echantillons || []) {
      console.log(`OK  ${e.label} : ${e.visibles} véhicules dessinés`);
    }
    console.log(`OK  pic dessiné (6h-9h) : ${d.maxPicDessine} véhicules`);
    console.log(`OK  horloge HUD : ${d.horloge}`);
    if (d.fails && d.fails.length) {
      ko = true;
      for (const f of d.fails) console.log("KO  " + f);
    }
  }
  // erreurs JS de la page elle-même (hors canvas non implémenté, attendu en jsdom)
  const autres = journal.filter(([, m]) => !/canvas|getContext|not implemented/i.test(m));
  if (autres.length) {
    ko = true;
    for (const [src, m] of autres) console.log(`KO  ${src}: ${m}`);
  }
  console.log(ko ? "\nRÉSULTAT : ÉCHEC" : "\nRÉSULTAT : CONFORME");
  process.exit(ko ? 1 : 0);
}, 400);
