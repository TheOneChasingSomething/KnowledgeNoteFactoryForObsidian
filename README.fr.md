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

**Modale.** Si une note est active, l'option *Transformer la note active* (cochée par défaut) réutilise son contenu — sinon une note vide (ou issue du template ressource configurable) est créée. Champs demandés : auteur (saisie assistée depuis une liste configurable : ChatGPT, Claude, ClaudeIA, Lumo…), titre, URL, **projet** et **knowledge-index** (champs de type lien : commencer à saisir le nom de la note — ou coller `[[…]]` — pour obtenir des suggestions façon Obsidian, restreintes au dossier des projets / `0 - Index`), tâche et TrustLevel. Si le nom de la note active suit déjà le schéma `Auteur - Titre`, les deux champs sont pré-remplis.

**Effets.**
1. La note est nommée `Auteur - Titre`, dotée du frontmatter type (`Author`, `URL`, `Publication`, `Lecture`, `Project`, `Task`, `Knowledge-index`, `TrustLevel`, `download`, `Tags`) et **déplacée dans `0_inbox`** — le renommage passe par `fileManager.renameFile`, qui met à jour les backlinks existants⁴.
2. **Tags automatiques** : tags fixes (`literature-note`, `ressources-note`, `resource`, `resource-note`) + sujet extrait du knowledge-index (ex. `{{ GIT }}` → `Git`) + mots-clés configurables détectés dans le titre et le contenu (Git, TLS, SSH, MITM, Docker…), sans doublon.
3. Le lien `- [[Auteur - Titre]]` est inséré **dans la note projet sous `Ressources` > `LLM`** et **dans la note index sous `LLM`** (chaînes de titres configurables dans les réglages), groupé après la dernière puce du même auteur (le groupement distingue `Claude` de `ClaudeIA` par frontière de mot). Depuis la v1.2, les titres de section sont détectés de façon **tolérante** : titres ATX (`## LLM`), lignes en gras (`**LLM**`) et lignes de texte simple (`LLM`) sont tous reconnus, un suffixe est accepté (`## LLM :`), et si le titre parent (`Ressources`) est absent le plugin **se replie sur le dernier titre trouvé n'importe où dans la note** — les titres ne sont créés que si rien ne correspond. Un lien déjà présent n'est jamais dupliqué.

## 4. Notes projet et tâche (v1.3)

**« Create a project note ».** La modale demande un titre, un nom court (`project.name`, par défaut le titre sans espaces) et les champs `parent` / `status` / `type`. La note est créée dans le dossier des projets sous la forme `<id> - ~~ Titre ~~` avec le frontmatter `tags: project-note` + bloc `project` (name/parent/status/type) et — si aucun template projet n'est configuré — un squelette de corps intégré : `Objectifs`, `Liste des tâches`, `Notes`, `LLM`. Créé dans le dossier des projets, le nouveau projet apparaît immédiatement dans les listes déroulantes des ressources et des tâches.

**« Create a task note ».** La modale demande un titre, le **projet** (champ de type lien avec suggestions façon `[[`), `status` et `type`. La note est créée dans le dossier des tâches (`6_Projects` par défaut) sous la forme `<id> - Titre` (sans décoration). Depuis la v1.5, l'**id de la tâche est dérivé de l'id du projet** : un id de projet finissant par une lettre reçoit des suffixes numériques (`202604270829h` → `202604270829h1`, `…h2`, `…h3`), un id finissant par un chiffre reçoit des suffixes alphabétiques à partir de `a` (`202605261545` → `202605261545a`, `…b`) ; le premier suffixe libre est choisi en parcourant les ids des notes existantes (comparaison exacte du jeton : `…h12` ne bloque jamais `…h1`), avec repli sur un horodatage si aucun projet n'est sélectionné. La note porte le frontmatter `tags: Task-Note`, une clé `production:` vide et un bloc `task` dont le champ `project` est lu dans le frontmatter de la note projet sélectionnée (`project.name`, via le cache de métadonnées — repli sur son titre sans décoration). Le lien `- [[<id> - Titre]]` est ensuite inséré **dans la note projet sous `Liste des tâches`** (titre configurable, même moteur tolérant de détection et de groupement que pour les ressources).

**« Set status — project or task (Pending / Pause) » (v1.6, étendu aux tâches en v1.9.1).** La modale pré-remplit la note active quand elle ressemble à un projet ou une tâche (dossier des projets/tâches, ou bloc `project`/`task` dans le frontmatter), sinon propose le même champ façon `[[`. Le type de note est détecté automatiquement — un bloc `task` ou un tag `Task-Note` en font une tâche — et le statut est écrit dans la bonne clé : `task.status` pour les tâches, `project.status` pour les projets (les versions précédentes injectaient à tort un bloc `project` dans les notes tâche ; la commande répare désormais aussi cette pollution en supprimant un bloc `project` ne portant qu'un statut sur une note tâche). Appliquer un statut fait deux choses : écrire le statut dans le frontmatter via l'API `processFrontMatter` d'Obsidian (sans casser la mise en forme), puis déplacer le **signet** du projet via le plugin natif Bookmarks — `Pending` le range dans le groupe de signets **`4 - InProgress`**, `Pause` dans **`3 - OnHold`** (noms des deux groupes configurables). Les titres de groupes sont reconnus **sans tenir compte de la casse et récursivement à toute profondeur** de l'arborescence des signets (v1.8.1) — un groupe `4 - InProgress` existant, même imbriqué dans un groupe parent, est réutilisé plutôt que dupliqué. Lors d'un changement de statut, le signet est retiré de **tous** les groupes portant l'autre statut (et des doublons du groupe cible), puis ajouté exactement une fois ; les groupes ne sont créés à la racine que si rien ne correspond, et les autres signets ne sont pas touchés. Deux commandes compagnes, **« Set current note to Pending »** et **« Set current note to Pause »** (v1.10), court-circuitent la modale et appliquent le statut directement à la note en cours d'édition — même détection automatique et même déplacement de signet — de sorte qu'un changement de statut sur la note ouverte tient en un raccourci ; elles sont désactivées quand aucune note markdown n'est active. Si le plugin Bookmarks est désactivé, le frontmatter est tout de même mis à jour et une notification signale qu'aucun signet n'a été déplacé.

**« Initialize structure (folders, templates, bookmarks) » (v1.7).** Une commande d'installation idempotente qui lit les réglages courants et crée tout ce que le plugin attend, sans jamais toucher à l'existant : l'arborescence complète (les six sous-dossiers de `5_Knowledges`, `0_inbox`, `6_Projects`, `Ressources/Templates`, plus une liste supplémentaire configurable valant par défaut `2_References`, `4_Permanent`, `5_Knowledges`, `6_Projects`, `Ressources/Images`), un fichier de démarrage pour chaque template configuré manquant (squelettes de frontmatter conformes aux conventions du coffre, avec les jetons `{{…}}` ; le `permanent-note_template` partagé n'est créé qu'une fois), et les groupes de signets — `4 - InProgress` / `3 - OnHold` plus une liste supplémentaire configurable valant par défaut `0 - DashBoard` et `1 - Knowledge`, créés en ordre trié (0, 1, 3, 4). Une notification de synthèse indique le nombre de dossiers, templates et groupes créés — ou que la structure était déjà en place. Utile sur un coffre neuf, une nouvelle machine, ou après un renommage dans les réglages.

**« Check & normalize frontmatter » (v1.9).** Parcourt le frontmatter de toutes les notes du coffre et corrige trois familles de dérives, avec un bouton **Check** (rapport seul, rien n'est écrit) et un bouton **Normalize** (écriture via `processFrontMatter`, fichier par fichier, uniquement quand quelque chose change). Règles : les **statuts** (`status`, `project.status`, `task.status`) prennent une majuscule initiale (`pending` → `Pending`) ; les **types** (`type`, `project.type`, `task.type`) sont rapprochés, sans tenir compte de la casse, d'une liste canonique configurable (`Coding, VibeCoding, Challenge, Research, Knowledge, Config, Tooling`) avec un pont `-ing` (`researching` → `Research`), les valeurs inconnues recevant une simple capitale ; les **tags** (clés `tags` et `Tags`) sont convertis vers leur forme anglaise via une table `de=vers` configurable (`ressources-note` → `resources-note` — l'anglais est privilégié) puis une **liste de suppression** configurable retire les tags indésirables (par défaut : `resource`, `resources-note`), et enfin les tags sont dédoublonnés sans tenir compte de la casse. La conversion précède la suppression, de sorte qu'un tag français comme `ressources-note` est d'abord converti en `resources-note` puis supprimé s'il figure dans la liste. Le panneau de résultats liste chaque note concernée avec ses changements. Les tags par défaut des nouvelles notes ressources se limitent désormais à `literature-note` et `resource-note`, en cohérence avec la liste de suppression.

## 5. Lanceur Video Notes Manager (v1.12, desktop uniquement)

Trois commandes pilotent le script Python externe [ObsidianVideoNotesManager](https://github.com/TheOneChasingSomething/ObsidianVideoNotesManager) depuis Obsidian, en le lançant dans un vrai terminal via le `child_process` de Node (disponible dans le moteur Electron de l'app desktop — les commandes sont masquées sur mobile) :

- **« open interactive menu (TUI) »** — exécute la commande de base sans argument, de sorte que le menu Typer du script s'affiche dans le terminal.
- **« run with arguments… »** — une modale où l'on tape les arguments CLI (`download video "URL"`, `download playlist PLxxx --max-videos 50`, …) ajoutés à la commande de base.
- **« download URL from clipboard »** — lit le presse-papiers, classe l'URL (YouTube watch/short → `video`, YouTube `list=` → `playlist`, sinon → `article`) et exécute la sous-commande correspondante ; l'URL est quotée en POSIX pour qu'aucun métacaractère shell ne puisse être injecté.

La configuration se trouve dans la section de réglages **Video Notes Manager** : le dossier du projet (le dépôt, utilisé comme répertoire de travail, `~` étendu), la commande de base (défaut `source venv/bin/activate && python3 main.py`), le shell, l'émulateur de terminal (préréglages `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`, `kitty`, `alacritty`, `x-terminal-emulator`, ou un binaire + flags personnalisés) et un interrupteur *garder le terminal ouvert*. Les URL du presse-papiers sont quotées sûrement ; le champ *run with arguments* est transmis au shell tel quel (mode expert). Un lancement en échec (mauvais binaire de terminal) est signalé par une notification.

**OAuth2 Google (v1.13).** Le script requiert des identifiants pour l'API YouTube Data et propose trois voies d'installation ; le plugin en couvre deux. Renseigne **Google client secrets** avec le chemin de ton `client_secrets.json` : il est exporté dans `YT_DL_SECRETS` (quoté POSIX, `~` étendu) avant chaque exécution — la voie « variable d'environnement ». Sinon, lance une fois la commande **« store Google credentials (keyring) »** : elle exécute la commande d'installation configurable dans un terminal pour ranger les secrets dans le keyring système (le one-liner par défaut reproduit la méthode documentée du dépôt — `keyring.set_password("yt_playlist_dl", "client_secrets", …)` en lisant `client_secrets*.json` dans le dossier du projet ; à noter que l'indice affiché à l'exécution par le script renvoie vers un module `yt_playlist_dl.store_secret` qui n'existe pas dans le paquet) — la voie recommandée, après quoi le fichier client_secrets peut être supprimé. Une commande **« revoke Google credentials »** exécute la sous-commande `revoke` du script. Le flux de consentement OAuth dans le navigateur est, lui, géré par le script au premier téléchargement.

**Téléchargement guidé (v1.15).** La commande **« download (guided — project & index) »** ouvre une modale qui pré-remplit l'URL depuis le presse-papiers, laisse choisir le **type** (auto/video/article), et sélectionner les notes **projet** et **knowledge-index** avec l'autocomplétion façon `[[`. À la validation, elle les passe au script en flags CLI (`--project`, `--knowledge-index`, noms configurables) ainsi que le **chemin absolu du coffre** d'Obsidian (`--vault`, désactivable) — puisqu'Obsidian connaît toujours sa propre localisation. Les noms de notes sont quotés POSIX. **Cela suppose que ton script Python accepte ces flags** : il lit actuellement projet/knowledge-index depuis `config.toml` (prompt si vide) et n'a pas d'option `--vault`, il faut donc ajouter les options CLI correspondantes (ou vider les noms de flags dans les réglages pour les omettre). Voir `Download Helper Dashboard.md` pour un tableau de bord Dataview qui liste les notes créées par le script (repérées par leur champ `download`), sépare les échecs (`download: KO`) et propose des boutons déclenchant ces commandes.

**Amorçage des dépendances (v1.14).** La commande **« install / check dependencies »** exécute une commande configurable qui crée le virtualenv s'il manque et lance `pip install -e .` **uniquement si les bibliothèques sont absentes** — la détection importe des dépendances tierces (`yt_dlp`, `keyring`, `typer`) plutôt que le paquet local, car ce dernier s'importe depuis le dossier du dépôt même sans installation. Elle est idempotente (ne fait rien si tout est déjà installé), c'est donc la commande à lancer après un clonage du dépôt sur une nouvelle machine.

## 6. Panneau de réglages

Tout est configurable dans **Paramètres → Knowledge Note Factory** : section **Projects & tasks** (template projet, titre de la liste des tâches, groupes de signets Pending/Pause, dossier des tâches, template tâche), dossier des templates, format de l'identifiant et de la date, valeurs par défaut du bloc `project`, et — pour chacun des six types — activation par défaut, dossier de destination et nom du template. Section **Notes ressources** : dossier inbox (`0_inbox`), dossier des projets utilisé pour la création et la portée des suggestions (`6_Projects` par défaut), template ressource optionnel, TrustLevel par défaut, liste des auteurs, mots-clés générateurs de tags et tags fixes.

## 7. Limites connues

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
