---
rédaction: 2026-08-02
tags:
  - dashboard
---

# 🎬 Dashboard — Download Helper (vidéos)

> [!info] Prérequis
> Plugin **Dataview** avec **Enable JavaScript Queries** activé. Les boutons déclenchent les commandes du plugin **Knowledge Note Factory** (téléchargement dans un terminal — desktop uniquement).

```dataviewjs
/* ============================================================
 * CONFIGURATION
 * ============================================================ */
const PLUGIN     = "knowledge-note-factory"; // id du plugin (préfixe des commandes)
const INBOX      = "0_inbox";                // où le script dépose ses notes
const LIMIT      = 12;                        // notes récentes affichées
const DL_FIELD   = "download";                // champ écrit par le script (chemin ou "KO")
const VIDEO_TAGS = ["video", "youtube"];      // tags marquant une vidéo (repli)

/* ---- Helpers ---- */
const run = (id) => app.commands.executeCommandById(PLUGIN + ":" + id);
const isFail = (v) => String(v).trim().toUpperCase() === "KO";

/* Une note est « vidéo » si son URL pointe vers YouTube, ou à défaut si elle
 * porte un tag vidéo. Fiable même quand le téléchargement a échoué (KO). */
function isVideo(p) {
  const url = String(p.URL ?? p.url ?? "");
  if (/(?:youtube\.com|youtu\.be)/i.test(url)) return true;
  const tags = (p.file.tags ?? []).map(t => String(t).toLowerCase().replace(/^#/, ""));
  return VIDEO_TAGS.some(vt => tags.includes(vt));
}

/* Notes vidéo créées par le script (champ download présent), plus récentes d'abord. */
function videoPages() {
  return dv.pages('"' + INBOX + '"')
    .where(p => p[DL_FIELD] !== undefined && p[DL_FIELD] !== null)
    .where(isVideo)
    .sort(p => p.file.ctime, "desc");
}

/* ============================================================
 * BOUTONS D'ACTION (commandes du plugin)
 * ============================================================ */
const bar = dv.el("div", "");
bar.style.display = "flex";
bar.style.flexWrap = "wrap";
bar.style.gap = "8px";
bar.style.margin = "4px 0 18px";
const actions = [
  ["⬇️ Téléchargement guidé", "video-download-guided"],
  ["📋 Depuis le presse-papiers", "video-download-clipboard"],
  ["🖥️ Menu interactif (TUI)", "video-open-tui"],
  ["🔑 Identifiants Google", "video-store-credentials"],
  ["📦 Installer / vérifier les libs", "video-install-deps"],
];
for (const [label, id] of actions) {
  const b = bar.createEl("button", { text: label });
  b.onclick = () => run(id);
}

/* ============================================================
 * STATISTIQUES (vidéos uniquement)
 * ============================================================ */
const all    = videoPages().array();
const failed = all.filter(p => isFail(p[DL_FIELD]));
const okDl   = all.filter(p => !isFail(p[DL_FIELD]));

const kpi = dv.el("div", "");
kpi.style.display = "flex";
kpi.style.gap = "24px";
kpi.style.flexWrap = "wrap";
kpi.style.margin = "0 0 16px";
const big = (label, value, color) => {
  const c = kpi.createEl("div"); c.style.textAlign = "center";
  const n = c.createEl("div", { text: String(value) });
  n.style.fontSize = "2em"; n.style.fontWeight = "700"; n.style.color = color;
  const l = c.createEl("div", { text: label });
  l.style.fontSize = "0.8em"; l.style.opacity = "0.7";
};
big("vidéos", all.length, "var(--text-normal)");
big("✅ réussies", okDl.length, "#98c379");
big("❌ échouées", failed.length, failed.length ? "#e06c75" : "var(--text-muted)");

/* ============================================================
 * ÉCHECS (download: KO) — à retélécharger
 * ============================================================ */
if (failed.length) {
  dv.header(2, "❌ Échecs — à relancer");
  dv.paragraph("_Relance via « Menu interactif » → Re-download known videos, ou la commande resources --retry du script._");
  dv.table(
    ["Note", "Auteur", "URL"],
    failed.slice(0, LIMIT).map(p => [
      p.file.link,
      p.Author ?? "—",
      p.URL ? "[lien](" + p.URL + ")" : "—",
    ])
  );
}

/* ============================================================
 * VIDÉOS RÉCENTES (plus récente en tête)
 * ============================================================ */
dv.header(2, "🆕 Vidéos récemment créées");
if (all.length === 0) {
  dv.paragraph("· Aucune note vidéo dans " + INBOX + ".");
} else {
  dv.table(
    ["Note", "Auteur", "Statut", "Fichier"],
    all.slice(0, LIMIT).map(p => {
      const v = p[DL_FIELD];
      const status = isFail(v) ? "❌ KO" : "✅ OK";
      const file = isFail(v) ? "—" : "`" + String(v).split("/").pop() + "`";
      return [p.file.link, p.Author ?? "—", status, file];
    })
  );
  if (all.length > LIMIT) {
    dv.paragraph("… et **" + (all.length - LIMIT) + "** autre(s) — **" + all.length + "** au total.");
  }
}
```

---

## Notes d'utilisation

- **Filtre vidéo.** Le dashboard n'affiche que les notes dont l'URL est une adresse YouTube (`youtube.com` / `youtu.be`), ou à défaut portant un tag `video`/`youtube` (`VIDEO_TAGS`). Ce critère fonctionne aussi pour les téléchargements échoués (`download: KO`), contrairement à l'extension du fichier.
- **Tri.** Par date de création de la note (`file.ctime`) décroissante — la plus récente en tête. Pour trier plutôt par date de publication de la vidéo, remplace `p.file.ctime` par `p.publication` dans `videoPages()`.
- **Boutons.** Ils appellent les commandes du plugin via `app.commands.executeCommandById` ; vérifie que `PLUGIN` correspond à l'id de ton `manifest.json`.
- **Échecs.** Les notes `download: KO` sont regroupées en tête pour être relancées.
