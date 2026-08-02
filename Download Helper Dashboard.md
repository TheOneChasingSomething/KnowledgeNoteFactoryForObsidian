---
rédaction: 2026-08-02
tags:
  - dashboard
---

# 🎬 Dashboard — Download Helper

> [!info] Prérequis
> Plugin **Dataview** avec **Enable JavaScript Queries** activé. Les boutons déclenchent les commandes du plugin **Knowledge Note Factory** (téléchargement dans un terminal — desktop uniquement).

```dataviewjs
/* ============================================================
 * CONFIGURATION
 * ============================================================ */
const PLUGIN   = "knowledge-note-factory"; // id du plugin (préfixe des commandes)
const INBOX    = "0_inbox";                // où le script dépose ses notes
const LIMIT    = 12;                       // notes récentes affichées
const DL_FIELD = "download";               // champ écrit par le script (chemin ou "KO")

/* ---- Helpers ---- */
const run = (id) => app.commands.executeCommandById(PLUGIN + ":" + id);
const isFail = (v) => String(v).trim().toUpperCase() === "KO";

/* Une note « de téléchargement » possède le champ download. */
function downloadPages() {
  return dv.pages('"' + INBOX + '"')
    .where(p => p[DL_FIELD] !== undefined && p[DL_FIELD] !== null)
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
 * STATISTIQUES
 * ============================================================ */
const all    = downloadPages().array();
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
big("téléchargements", all.length, "var(--text-normal)");
big("✅ réussis", okDl.length, "#98c379");
big("❌ échoués", failed.length, failed.length ? "#e06c75" : "var(--text-muted)");

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
 * TÉLÉCHARGEMENTS RÉCENTS
 * ============================================================ */
dv.header(2, "🆕 Notes récemment créées");
if (all.length === 0) {
  dv.paragraph("· Aucune note de téléchargement dans " + INBOX + ".");
} else {
  dv.table(
    ["Note", "Auteur", "Statut", "Vidéo/fichier"],
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

- **Repérage des notes.** Le dashboard identifie les notes du script par la présence du champ `download` (chemin du fichier téléchargé, ou `KO` en cas d'échec). Ajuste `INBOX`, `DL_FIELD` et `LIMIT` en tête de bloc si besoin.
- **Boutons.** Ils appellent les commandes du plugin via `app.commands.executeCommandById`. Vérifie que l'identifiant `PLUGIN` correspond bien à celui de ton `manifest.json` (`knowledge-note-factory`).
- **Échecs.** Les notes `download: KO` sont regroupées en tête pour être relancées (menu interactif → *Re-download known videos*, ou `resources --retry`).
