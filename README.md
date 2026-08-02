# Knowledge Note Factory — plugin Obsidian

Plugin communautaire non publié (installation manuelle) qui crée, en une seule commande, un jeu de notes liées dans l'arborescence `5_Knowledges`, à partir des templates du dossier `Ressources/Templates`.

## 1. Installation

1. Dans le coffre, créer le dossier `.obsidian/plugins/knowledge-note-factory/`.
2. Y déposer `main.js` et `manifest.json` (aucune compilation nécessaire : le plugin est écrit en JavaScript pur).
3. Recharger Obsidian, puis activer *Knowledge Note Factory* dans **Paramètres → Plugins communautaires** (le mode restreint doit être désactivé).

## 2. Usage

- Commande de palette : **« Créer un jeu de notes de connaissance »** (ou l'icône du ruban).
- Une modale demande le **sujet** (ex. `AI`), les champs `parent` / `status` / `type` du bloc `project` de l'index (pré-remplis avec les valeurs par défaut), et permet de cocher les types de notes à générer.
- Un identifiant horodaté unique est généré (`YYYYMMDDHHmm`, ex. `202607311530`) et partagé par toutes les notes du jeu.

Notes produites (validation de la touche *Entrée* ou bouton **Créer**) :

| Type | Dossier (défaut) | Template (défaut) | Nom de fichier |
|---|---|---|---|
| Index | `5_Knowledges/0 - Index` | `index-note_template` | `<id> - {{ AI }}` |
| Flashcard | `5_Knowledges/1 - Flashcard` | `flashcard_template` | `<id> - == AI ==` |
| CheatSheet | `5_Knowledges/2 - CheatSheet` | `cheatsheet-note_template` | `<id> - "" AI ""` |
| Gist | `5_Knowledges/3 - Gist` | `gist_template` | `<id> - @@ AI @@` |
| Slides | `5_Knowledges/5 - Slides` | `permanent-note_template` | `<id> - ** AI **` |
| Groom | `5_Knowledges/6 - Groom` | `permanent-note_template` | `<id> - ;; AI ;;` |

### Frontmatter généré

Le plugin **impose** les champs du cahier des charges et **conserve** toute clé supplémentaire présente dans le template :

- Toutes : `rédaction: <date du jour>` ;
- Index : `tags: project-knowledge-note` + bloc `project` (`name` = sujet, `parent`, `status`, `type` saisis dans la modale) ;
- Flashcard / CheatSheet / Gist : `Knowledge-index: "[[<id> - {{ Sujet }}]]"` + tags `permanent-note` et `flashcard-note` / `cheatsheet-note` / `gist-note` ;
- Slides / Groom : `ImpactScore:` + tag `permanent-note`.

Corps ajouté automatiquement s'il est absent du template : `## <nom complet>` pour le Gist ; `# <nom complet>` suivi de `index links :` pour les Slides.

### Jetons utilisables dans le corps des templates

`{{ <input> }}` ou `<input>` → sujet · `{{title}}` → nom complet de la note · `{{id}}` → identifiant · `{{date}}` → date du jour · `{{index}}` → lien `[[...]]` vers l'index.

## 3. Panneau de réglages

Tout est configurable dans **Paramètres → Knowledge Note Factory** : dossier des templates, format de l'identifiant et de la date, valeurs par défaut du bloc `project`, et — pour chacun des six types — activation par défaut, dossier de destination et nom du template.

## 4. Limites connues

1. **Caractères de nommage.** Les décorations `"" ""` et `** **` contiennent des caractères (`"`, `*`) interdits par le système de fichiers Windows (réservés par l'API Win32)¹. Sous Linux/macOS le schéma fonctionne tel quel ; pour un coffre synchronisé avec Windows, activer l'option **« Assainir les noms de fichier »**, qui substitue les équivalents Unicode pleine-chasse `＊` et `＂`.
2. **Syntaxe Templater.** Le plugin insère le contenu brut des templates : les balises Templater (`<% ... %>`) ne sont **pas** exécutées². Les jetons listés ci-dessus (inspirés du plugin *Templates* natif³) couvrent les substitutions demandées ; les templates existants restent utilisables si leurs champs dynamiques se limitent au frontmatter, que le plugin régénère de toute façon.
3. **Collision d'identifiants.** Deux jeux créés dans la même minute partageraient un identifiant ; la note existante est alors détectée et ignorée avec notification. Passer `idFormat` à `YYYYMMDDHHmmss` pour une granularité à la seconde.

## Sources

1. Microsoft, « Naming Files, Paths, and Namespaces », *Win32 API documentation*, learn.microsoft.com — caractères réservés `< > : " / \ | ? *`.
2. SilentVoid13, *Templater — Documentation*, silentvoid13.github.io/Templater — exécution des commandes `tp` limitée au plugin Templater.
3. Obsidian, « Templates », *Obsidian Help*, help.obsidian.md — jetons `{{title}}`, `{{date}}`.
4. Obsidian, *Developer Documentation — Build a plugin*, docs.obsidian.md — API `Plugin`, `Modal`, `PluginSettingTab`, `Vault.create`.

## Annexe A — Questions pour flashcards

1. Quel dossier du coffre reçoit les fichiers `main.js` et `manifest.json` d'un plugin installé manuellement ?
2. Quels caractères des décorations CheatSheet et Slides posent problème sous Windows, et quelle option du plugin les neutralise ?
3. Quels champs de frontmatter le plugin impose-t-il à une note Flashcard ?
4. Quel jeton insérer dans un template pour obtenir un lien vers la note index ?
5. Pourquoi les balises `<% ... %>` d'un template restent-elles inertes après création par le plugin ?

## Annexe B — Acronymes

- **API** (*Application Programming Interface*) : interface de programmation exposée par Obsidian aux plugins (classes `Plugin`, `Vault`, etc.).
- **YAML** (*YAML Ain't Markup Language*) : langage de sérialisation utilisé pour le frontmatter des notes Obsidian.
- **CTA** (*Call To Action*) : dans l'API Obsidian, style de bouton mis en évidence (`setCta()`), utilisé pour le bouton « Créer ».
- **ID** (*Identifier*) : ici, identifiant horodaté `YYYYMMDDHHmm` partagé par toutes les notes d'un même jeu.
- **UI** (*User Interface*) : interface utilisateur — modale de saisie et panneau de réglages du plugin.
