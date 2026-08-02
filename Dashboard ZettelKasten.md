---
rédaction: 2026-08-02
tags:
  - dashboard
cssclasses:
  - wide-page
---

# 🗂️ Dashboard ZettelKasten

> [!info] Prérequis
> Ce tableau de bord nécessite le plugin **Dataview** avec l'option **Enable JavaScript Queries** activée (Réglages → Dataview). Les boutons déplacent des fichiers et modifient le frontmatter via l'API d'Obsidian.

```dataviewjs
/* ============================================================
 * CONFIGURATION — ajuste ces noms pour qu'ils correspondent
 * EXACTEMENT à tes dossiers (la casse compte sous Linux).
 * ============================================================ */
const F = {
  inbox:      "0_inbox",
  notes:      "1_Notes",
  references: "2_References",
  permanent:  "4_Permanent",
};
const TRUST_FIELD    = "TrustLevel"; // champ de confiance
const TRUST_VERIFIED = 1;            // valeur quand l'info est vérifiée
const LIMIT          = 8;            // notes affichées par étape (anti-saturation)

/* ---- Notice, avec repli si indisponible ---- */
let Notice;
try { Notice = require("obsidian").Notice; }
catch (e) { Notice = class { constructor(m) { console.log(m); } }; }

/* ---- Helpers ---- */
const tfile = (page) => app.vault.getAbstractFileByPath(page.file.path);

async function ensureFolder(path) {
  if (!app.vault.getAbstractFileByPath(path)) {
    try { await app.vault.createFolder(path); } catch (e) {}
  }
}

async function moveTo(page, folder, frontmatterFn) {
  const file = tfile(page);
  if (!file) { new Notice("Fichier introuvable."); return; }
  await ensureFolder(folder);
  const target = folder + "/" + file.name;
  if (app.vault.getAbstractFileByPath(target)) { new Notice("Existe déjà : " + target); return; }
  if (frontmatterFn) {
    try { await app.fileManager.processFrontMatter(file, frontmatterFn); }
    catch (e) { new Notice("Frontmatter : " + e.message); }
  }
  await app.fileManager.renameFile(file, target);
  new Notice(file.basename + " → " + folder);
}

async function createPermanent(page) {
  await ensureFolder(F.permanent);
  const id    = window.moment().format("YYYYMMDDHHmm");
  const clean = page.file.name.replace(/^\S+\s*-\s*/, "").replace(/[~"@*;{}=]/g, "").trim();
  const title = clean || page.file.name;
  const base  = id + " - " + title;
  const path  = F.permanent + "/" + base + ".md";
  if (app.vault.getAbstractFileByPath(path)) { new Notice("Existe déjà : " + base); return; }
  const content = [
    "---",
    "rédaction: " + window.moment().format("YYYY-MM-DD"),
    "ImpactScore:",
    "tags:",
    "  - permanent-note",
    'source: "[[' + page.file.name + ']]"',
    "---",
    "",
    "# " + base,
    "",
    "Reformulation, avec mes propres mots, de [[" + page.file.name + "]].",
    "",
  ].join("\n");
  const created = await app.vault.create(path, content);
  new Notice("Note permanente créée : " + base);
  app.workspace.getLeaf(false).openFile(created);
}

/* ---- Comptages ---- */
const count = (folder) => dv.pages('"' + folder + '"').length;
const counts = {
  "0 · Inbox":      count(F.inbox),
  "1 · Notes":      count(F.notes),
  "2 · References": count(F.references),
  "4 · Permanent":  count(F.permanent),
};
const total     = Object.values(counts).reduce((a, b) => a + b, 0);
const permanent = counts["4 · Permanent"];
const pct       = total ? Math.round((permanent / total) * 100) : 0;

/* =========================  MOTIVATION  ========================= */
dv.header(2, "📊 Avancement");

/* Indicateurs */
const kpi = dv.el("div", "");
kpi.style.display = "flex";
kpi.style.gap = "24px";
kpi.style.flexWrap = "wrap";
kpi.style.margin = "4px 0 16px";
const bigNum = (label, value, color) => {
  const c = kpi.createEl("div");
  c.style.textAlign = "center";
  const n = c.createEl("div", { text: String(value) });
  n.style.fontSize = "2.1em"; n.style.fontWeight = "700"; n.style.color = color;
  const l = c.createEl("div", { text: label });
  l.style.fontSize = "0.8em"; l.style.opacity = "0.7";
};
bigNum("notes au total", total, "var(--text-normal)");
bigNum("💎 permanentes", permanent, "#98c379");
bigNum("% cycle complet", pct + "%", "#61afef");

/* Barre de progression (proportion par étape) */
const colors = ["#e06c75", "#e5c07b", "#61afef", "#98c379"];
const progress = dv.el("div", "");
progress.style.display = "flex";
progress.style.height = "22px";
progress.style.borderRadius = "6px";
progress.style.overflow = "hidden";
progress.style.margin = "0 0 20px";
progress.style.border = "1px solid var(--background-modifier-border)";
Object.entries(counts).forEach(([k, v], i) => {
  if (!v) return;
  const seg = progress.createEl("div", { text: v > 0 ? String(v) : "" });
  seg.style.flex = String(v);
  seg.style.background = colors[i];
  seg.style.color = "#1e2327";
  seg.style.fontSize = "12px";
  seg.style.display = "flex";
  seg.style.alignItems = "center";
  seg.style.justifyContent = "center";
  seg.title = k + " : " + v;
});

/* Histogramme SVG des effectifs par étape */
function barChart(data) {
  const entries = Object.entries(data);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const W = 520, barH = 26, gap = 14, labelW = 110, pad = 8, valW = 40;
  const H = pad * 2 + entries.length * (barH + gap) - gap;
  let svg = "";
  entries.forEach(([k, v], i) => {
    const y = pad + i * (barH + gap);
    const w = Math.round((W - labelW - valW) * v / max);
    svg += '<text x="0" y="' + (y + barH / 2) + '" dominant-baseline="middle" font-size="13" fill="var(--text-normal)">' + k + "</text>";
    svg += '<rect x="' + labelW + '" y="' + y + '" width="' + w + '" height="' + barH + '" rx="4" fill="' + colors[i] + '"></rect>';
    svg += '<text x="' + (labelW + w + 6) + '" y="' + (y + barH / 2) + '" dominant-baseline="middle" font-size="13" fill="var(--text-normal)">' + v + "</text>";
  });
  return '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" style="max-width:' + W + 'px">' + svg + "</svg>";
}
dv.el("div", "").innerHTML = barChart(counts);

/* =========================  ÉTAPES  ========================= */
function stage(title, folder, help, button) {
  dv.header(2, title);
  if (help) dv.paragraph("_" + help + "_");
  const arr = dv.pages('"' + folder + '"').sort(p => p.file.mtime, "desc").array();
  if (arr.length === 0) { dv.paragraph("· Aucune note."); return; }
  const shown = arr.slice(0, LIMIT);
  for (const p of shown) {
    const row = dv.el("div", "");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.padding = "3px 0";
    const link = row.createEl("a", { text: p.file.name });
    link.style.flex = "1";
    link.style.cursor = "pointer";
    link.onclick = (e) => { e.preventDefault(); app.workspace.openLinkText(p.file.path, "", false); };
    if (button) {
      const b = row.createEl("button", { text: button.label });
      b.onclick = async () => {
        b.disabled = true;
        try { await button.action(p); } catch (err) { new Notice("Erreur : " + err.message); b.disabled = false; }
      };
    }
  }
  if (arr.length > LIMIT) {
    dv.paragraph("… et **" + (arr.length - LIMIT) + "** autre(s) — **" + arr.length + "** au total.");
  }
}

stage(
  "📥 0 · Inbox",
  F.inbox,
  "Capturé, non traité — lecture en diagonale. Bouton : prendre des notes.",
  { label: "Prendre des notes → 1_Notes", action: (p) => moveTo(p, F.notes) }
);

stage(
  "📝 1 · Notes",
  F.notes,
  "Notes rédigées après lecture. Bouton : marquer comme vérifié (déplace + " + TRUST_FIELD + " = " + TRUST_VERIFIED + ").",
  {
    label: "Vérifié → 2_References",
    action: (p) => moveTo(p, F.references, (fm) => { fm[TRUST_FIELD] = TRUST_VERIFIED; }),
  }
);

stage(
  "✅ 2 · References",
  F.references,
  "Informations vérifiées. Bouton : reformuler en note permanente (crée la note + lien retour).",
  { label: "Reformuler → note permanente", action: (p) => createPermanent(p) }
);

stage(
  "💎 4 · Permanent",
  F.permanent,
  "Reformulation personnelle — fin du cycle.",
  null
);
```

---

## Notes d'utilisation

- **Casse des dossiers.** Sous Linux, `0_Inbox` et `0_inbox` sont deux dossiers différents. Ajuste l'objet `F` en tête de bloc pour qu'il corresponde exactement à ton arborescence.
- **Champ de confiance.** Le passage en *References* écrit `TrustLevel: 1`. Change `TRUST_VERIFIED` si ta cible diffère ; le champ démarre à `-2` à la création d'une ressource.
- **Anti-saturation.** `LIMIT` (8 par défaut) borne le nombre de notes affichées par étape ; le total réel reste indiqué sous chaque liste.
- **Rafraîchissement.** Après un clic, Dataview réactualise la vue dès qu'Obsidian a indexé le changement (déplacement ou création). Si l'affichage tarde, `Ctrl/Cmd + P → Dataview: Rebuild current view`.
