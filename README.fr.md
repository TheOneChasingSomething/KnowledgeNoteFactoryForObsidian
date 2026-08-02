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

## 3. Notes ressources (v1.1)

Commande de palette : **« Créer une note ressource »**, destinée à archiver une source (conversation LLM, article…) dans `0_inbox` et à la relier au projet et au knowledge-index.

**Modale.** Si une note est active, l'option *Transformer la note active* (cochée par défaut) réutilise son contenu — sinon une note vide (ou issue du template ressource configurable) est créée. Champs demandés : auteur (saisie assistée depuis une liste configurable : ChatGPT, Claude, ClaudeIA, Lumo…), titre, URL, **projet** (liste déroulante des notes du dossier projets), **knowledge-index** (liste déroulante du dossier `0 - Index`), tâche et TrustLevel. Si le nom de la note active suit déjà le schéma `Auteur - Titre`, les deux champs sont pré-remplis.

**Effets.**
1. La note est nommée `Auteur - Titre`, dotée du frontmatter type (`Author`, `URL`, `Publication`, `Lecture`, `Project`, `Task`, `Knowledge-index`, `TrustLevel`, `download`, `Tags`) et **déplacée dans `0_inbox`** — le renommage passe par `fileManager.renameFile`, qui met à jour les backlinks existants⁴.
2. **Tags automatiques** : tags fixes (`literature-note`, `ressources-note`, `resource`, `resource-note`) + sujet extrait du knowledge-index (ex. `{{ GIT }}` → `Git`) + mots-clés configurables détectés dans le titre et le contenu (Git, TLS, SSH, MITM, Docker…), sans doublon.
3. Le lien `- [[Auteur - Titre]]` est inséré **dans la note projet sous `Ressources` > `LLM`** et **dans la note index sous `LLM`** (chaînes de titres configurables dans les réglages), groupé après la dernière puce du même auteur (le groupement distingue `Claude` de `ClaudeIA` par frontière de mot). Depuis la v1.2, les titres de section sont détectés de façon **tolérante** : titres ATX (`## LLM`), lignes en gras (`**LLM**`) et lignes de texte simple (`LLM`) sont tous reconnus, un suffixe est accepté (`## LLM :`), et si le titre parent (`Ressources`) est absent le plugin **se replie sur le dernier titre trouvé n'importe où dans la note** — les titres ne sont créés que si rien ne correspond. Un lien déjà présent n'est jamais dupliqué.

## 4. Notes projet et tâche (v1.3)

**« Create a project note ».** La modale demande un titre, un nom court (`project.name`, par défaut le titre sans espaces) et les champs `parent` / `status` / `type`. La note est créée dans le dossier des projets sous la forme `<id> - ~~ Titre ~~` avec le frontmatter `tags: project-note` + bloc `project` (name/parent/status/type) et — si aucun template projet n'est configuré — un squelette de corps intégré : `Objectifs`, `Liste des tâches`, `Notes`, `LLM`. Créé dans le dossier des projets, le nouveau projet apparaît immédiatement dans les listes déroulantes des ressources et des tâches.

**« Create a task note ».** La modale demande un titre, le **projet** (liste déroulante), `status` et `type`. La note est créée dans le dossier des tâches sous la forme `<id> - Titre` (sans décoration) avec le frontmatter `tags: Task-Note`, une clé `production:` vide et un bloc `task` dont le champ `project` est lu dans le frontmatter de la note projet sélectionnée (`project.name`, via le cache de métadonnées — repli sur son titre sans décoration). Le lien `- [[<id> - Titre]]` est ensuite inséré **dans la note projet sous `Liste des tâches`** (titre configurable, même moteur tolérant de détection et de groupement que pour les ressources).

## 5. Panneau de réglages

Tout est configurable dans **Paramètres → Knowledge Note Factory** : section **Projects & tasks** (template projet, titre de la liste des tâches, dossier des tâches, template tâche), dossier des templates, format de l'identifiant et de la date, valeurs par défaut du bloc `project`, et — pour chacun des six types — activation par défaut, dossier de destination et nom du template. Section **Notes ressources** : dossier inbox (`0_inbox`), dossier des projets scanné par la liste déroulante (`1_Projects` par défaut — à ajuster selon ton coffre), template ressource optionnel, TrustLevel par défaut, liste des auteurs, mots-clés générateurs de tags et tags fixes.

## 6. Limites connues

1. **Caractères de nommage.** Les décorations `"" ""` et `** **` contiennent des caractères (`"`, `*`) interdits par le système de fichiers Windows (réservés par l'API Win32)¹. Sous Linux/macOS le schéma fonctionne tel quel ; pour un coffre synchronisé avec Windows, activer l'option **« Assainir les noms de fichier »**, qui substitue les équivalents Unicode pleine-chasse `＊` et `＂`.
2. **Syntaxe Templater.** Le plugin insère le contenu brut des templates : les balises Templater (`<% ... %>`) ne sont **pas** exécutées². Les jetons listés ci-dessus (inspirés du plugin *Templates* natif³) couvrent les substitutions demandées ; les templates existants restent utilisables si leurs champs dynamiques se limitent au frontmatter, que le plugin régénère de toute façon.
3. **Collision d'identifiants.** Deux jeux créés dans la même minute partageraient un identifiant ; la note existante est alors détectée et ignorée avec notification. Passer `idFormat` à `YYYYMMDDHHmmss` pour une granularité à la seconde.

## Sources

1. Microsoft, « Naming Files, Paths, and Namespaces », *Win32 API documentation*, learn.microsoft.com — caractères réservés `< > : " / \ | ? *`.
2. SilentVoid13, *Templater — Documentation*, silentvoid13.github.io/Templater — exécution des commandes `tp` limitée au plugin Templater.
3. Obsidian, « Templates », *Obsidian Help*, help.obsidian.md — jetons `{{title}}`, `{{date}}`.
4. Obsidian, *Developer Documentation — Build a plugin*, docs.obsidian.md — API `Plugin`, `Modal`, `PluginSettingTab`, `Vault.create`, `FileManager.renameFile`.

## Annexe A — Questions pour flashcards

1. Quel dossier du coffre reçoit les fichiers `main.js` et `manifest.json` d'un plugin installé manuellement ?
2. Quelles sont les trois sources des tags automatiques d'une note ressource ?
3. Sous quels titres le lien d'une note ressource est-il inséré dans la note projet, et dans la note index ?
4. Pourquoi le déplacement vers `0_inbox` utilise-t-il `fileManager.renameFile` plutôt qu'une copie ?
5. Quels caractères des décorations CheatSheet et Slides posent problème sous Windows, et quelle option du plugin les neutralise ?
6. Quels champs de frontmatter le plugin impose-t-il à une note Flashcard ?
7. Quel jeton insérer dans un template pour obtenir un lien vers la note index ?
8. Pourquoi les balises `<% ... %>` d'un template restent-elles inertes après création par le plugin ?

## Annexe B — Acronymes

- **API** (*Application Programming Interface*) : interface de programmation exposée par Obsidian aux plugins (classes `Plugin`, `Vault`, etc.).
- **YAML** (*YAML Ain't Markup Language*) : langage de sérialisation utilisé pour le frontmatter des notes Obsidian.
- **CTA** (*Call To Action*) : dans l'API Obsidian, style de bouton mis en évidence (`setCta()`), utilisé pour le bouton « Créer ».
- **ID** (*Identifier*) : ici, identifiant horodaté `YYYYMMDDHHmm` partagé par toutes les notes d'un même jeu.
- **UI** (*User Interface*) : interface utilisateur — modale de saisie et panneau de réglages du plugin.
