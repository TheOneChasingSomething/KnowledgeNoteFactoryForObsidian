# Knowledge Note Factory — Obsidian plugin

Unpublished community plugin (manual install) that creates, in a single command, a set of linked notes in the `5_Knowledges` tree from the templates in `Ressources/Templates`, and files resource notes (LLM conversations, articles…) into `0_inbox` with automatic backlinks. *(Version française : voir `README.fr.md`.)*

## 1. Installation

1. In the vault, create the folder `.obsidian/plugins/knowledge-note-factory/`.
2. Drop `main.js` and `manifest.json` into it (no build step: the plugin is plain JavaScript).
3. Reload Obsidian, then enable *Knowledge Note Factory* under **Settings → Community plugins** (restricted mode must be off).

## 2. Knowledge note sets

Palette command: **"Create a knowledge note set"** (or the ribbon icon). A modal asks for the **subject** (e.g. `AI`), the `parent` / `status` / `type` fields of the index's `project` block (prefilled with defaults), and lets you toggle which note types to generate. A unique timestamped identifier is generated (`YYYYMMDDHHmm`, e.g. `202607311530`) and shared by every note in the set.

| Type | Folder (default) | Template (default) | File name |
|---|---|---|---|
| Index | `5_Knowledges/0 - Index` | `index-note_template` | `<id> - {{ AI }}` |
| Flashcard | `5_Knowledges/1 - Flashcard` | `flashcard_template` | `<id> - == AI ==` |
| CheatSheet | `5_Knowledges/2 - CheatSheet` | `cheatsheet-note_template` | `<id> - "" AI ""` |
| Gist | `5_Knowledges/3 - Gist` | `gist_template` | `<id> - @@ AI @@` |
| Slides | `5_Knowledges/5 - Slides` | `permanent-note_template` | `<id> - ** AI **` |
| Groom | `5_Knowledges/6 - Groom` | `permanent-note_template` | `<id> - ;; AI ;;` |

### Generated frontmatter

The plugin **enforces** the required fields and **preserves** any extra key present in the template:

- All notes: `rédaction: <today>`;
- Index: `tags: project-knowledge-note` + `project` block (`name` = subject, `parent`, `status`, `type` from the modal);
- Flashcard / CheatSheet / Gist: `Knowledge-index: "[[<id> - {{ Subject }}]]"` + tags `permanent-note` and `flashcard-note` / `cheatsheet-note` / `gist-note`;
- Slides / Groom: `ImpactScore:` + tag `permanent-note`.

Body automatically added when missing from the template: `## <full name>` for the Gist; `# <full name>` followed by `index links :` for the Slides.

### Tokens usable in template bodies

`{{ <input> }}` or `<input>` → subject · `{{title}}` → full note name · `{{id}}` → identifier · `{{date}}` → today's date · `{{index}}` → `[[...]]` link to the index note.

## 3. Resource notes (v1.1)

Palette command: **"Create a resource note"**, meant to archive a source (LLM conversation, article…) into `0_inbox` and link it back to its project and knowledge-index.

**Modal.** If a note is active, the *Transform the active note* option (checked by default) reuses its content — otherwise a blank note (or one from the optional resource template) is created. Fields: author (assisted input from a configurable list: ChatGPT, Claude, ClaudeIA, Lumo…), title, URL, **project** and **knowledge-index** (link-style fields: start typing the note name — or paste `[[…]]` — to get Obsidian-like suggestions, scoped to the projects folder / `0 - Index`), task and TrustLevel. If the active note's name already follows the `Author - Title` scheme, both fields are prefilled.

**Effects.**
1. The note is named `Author - Title`, given the standard frontmatter (`Author`, `URL`, `Publication`, `Lecture`, `Project`, `Task`, `Knowledge-index`, `TrustLevel`, `download`, `Tags`) and **moved into `0_inbox`** — the move goes through `fileManager.renameFile`, which updates existing backlinks⁴.
2. **Automatic tags**: fixed tags (`literature-note`, `ressources-note`, `resource`, `resource-note`) + subject extracted from the knowledge-index (e.g. `{{ GIT }}` → `Git`) + configurable keywords detected in the title and content (Git, TLS, SSH, MITM, Docker…), deduplicated.
3. The link `- [[Author - Title]]` is inserted **into the project note under `Ressources` > `LLM`** and **into the index note under `LLM`** (both heading chains configurable in the settings), grouped after the last bullet by the same author (grouping distinguishes `Claude` from `ClaudeIA` via word boundaries). Since v1.2, section titles are matched **tolerantly**: ATX headings (`## LLM`), standalone bold lines (`**LLM**`) and bare text lines (`LLM`) are all recognized, an optional suffix is accepted (`## LLM :`), and if the parent heading (`Ressources`) is absent the plugin **falls back to the final title found anywhere in the note** — headings are only created when nothing matches at all. An existing link is never duplicated.

## 4. Project and task notes (v1.3)

**"Create a project note".** The modal asks for a title, a short name (`project.name`, defaulting to the title without spaces), and the `parent` / `status` / `type` fields. The note is created in the projects folder as `<id> - ~~ Title ~~` with the frontmatter `tags: project-note` + `project` block (name/parent/status/type), and — when no project template is configured — a built-in body skeleton: `Objectifs`, `Liste des tâches`, `Notes`, `LLM`. Since it lands in the projects folder, the new project immediately appears in the resource and task dropdowns.

**"Create a task note".** The modal asks for a title, the **project** (link-style field with `[[`-like suggestions), `status` and `type`. The note is created in the tasks folder (`6_Projects` by default) as `<id> - Title` (no decoration). Since v1.5, the task **id is derived from the project id**: a project id ending with a letter gets numeric suffixes (`202604270829h` → `202604270829h1`, `…h2`, `…h3`), one ending with a digit gets letter suffixes starting at `a` (`202605261545` → `202605261545a`, `…b`); the first unused suffix is chosen by scanning existing note ids (exact-token comparison, so `…h12` never blocks `…h1`), with a timestamp fallback when no project is selected. The note carries the frontmatter `tags: Task-Note`, an empty `production:` key and a `task` block whose `project` field is read from the selected project note's own frontmatter (`project.name`, via the metadata cache — falling back to its undecorated title). The link `- [[<id> - Title]]` is then inserted **into the project note under `Liste des tâches`** (configurable heading, same tolerant matching and grouping engine as resource links).

**"Set project status (Pending / Pause)" (v1.6).** The modal prefills the active note when it looks like a project (projects folder or `project` frontmatter block), otherwise offers the same `[[`-style field. Applying a status does two things: it sets `project.status` in the frontmatter through Obsidian's `processFrontMatter` API (formatting-safe), then moves the project's **bookmark** using the core Bookmarks plugin — `Pending` files it under the bookmark group **`4 - inProgress`**, `Pause` under **`3 - OnHold`** (both group names configurable). The groups are created at the bookmark root if missing, the bookmark is removed from the other managed group, never duplicated, and other bookmarks are left untouched. If the core Bookmarks plugin is disabled, the frontmatter is still updated and a notice says no bookmark was moved.

**"Initialize structure (folders, templates, bookmarks)" (v1.7).** One idempotent setup command that reads the current settings and creates everything the plugin expects, without ever touching what already exists: the whole folder tree (the six `5_Knowledges` subfolders, `0_inbox`, `6_Projects`, `Ressources/Templates`, plus a configurable extra list defaulting to `2_References`, `4_Permanent`, `5_Knowledges`, `6_Projects`, `Ressources/Images`), a starter file for each missing configured template (frontmatter skeletons matching the vault's conventions, hosting the `{{…}}` tokens; the shared `permanent-note_template` is created once), and the bookmark groups — `4 - inProgress` / `3 - OnHold` plus a configurable extra list defaulting to `0 - DashBoard` and `1 - Knowledge`, created in sorted order (0, 1, 3, 4). A summary notice reports how many folders, templates and groups were created — or that the structure was already in place. Useful on a fresh vault, on a new machine, or after renaming things in the settings.

## 5. Settings panel

Everything is configurable under **Settings → Knowledge Note Factory**: **Projects & tasks** section (project template, task-list heading, Pending/Pause bookmark groups, tasks folder, task template), template folder, identifier and date formats, defaults of the `project` block, and — for each of the six types — default activation, destination folder and template name. **Resource notes** section: inbox folder (`0_inbox`), projects folder used for note creation and suggestion scoping (`6_Projects` by default), optional resource template, default TrustLevel, author list, tag-generating keywords and fixed tags.

## 6. Known limitations

1. **File-name characters.** The `"" ""` and `** **` decorations contain characters (`"`, `*`) forbidden by the Windows file system (reserved by the Win32 API)¹. On Linux/macOS the scheme works as is; for a vault synced with Windows, enable **"Sanitize file names"**, which substitutes the full-width Unicode equivalents `＊` and `＂`.
2. **Templater syntax.** The plugin inserts raw template content: Templater tags (`<% ... %>`) are **not** executed². The tokens listed above (inspired by the core *Templates* plugin³) cover the required substitutions; existing templates remain usable as long as their dynamic fields are limited to the frontmatter, which the plugin regenerates anyway.
3. **Identifier collision.** Two sets created within the same minute would share an identifier; the existing note is then detected and skipped with a notification. Set `idFormat` to `YYYYMMDDHHmmss` for one-second granularity.

## Sources

1. Microsoft, "Naming Files, Paths, and Namespaces", *Win32 API documentation*, learn.microsoft.com — reserved characters `< > : " / \ | ? *`.
2. SilentVoid13, *Templater — Documentation*, silentvoid13.github.io/Templater — `tp` commands executed only by the Templater plugin.
3. Obsidian, "Templates", *Obsidian Help*, help.obsidian.md — `{{title}}`, `{{date}}` tokens.
4. Obsidian, *Developer Documentation — Build a plugin*, docs.obsidian.md — `Plugin`, `Modal`, `PluginSettingTab`, `Vault.create`, `FileManager.renameFile` API.

## Appendix A — Flashcard questions

1. Which vault folder receives the `main.js` and `manifest.json` files of a manually installed plugin?
2. What are the three sources of a resource note's automatic tags?
3. Under which headings is a resource-note link inserted in the project note, and in the index note?
4. Why does the move to `0_inbox` use `fileManager.renameFile` rather than a copy?
5. Which characters of the CheatSheet and Slides decorations are problematic on Windows, and which plugin option neutralizes them?
6. Which frontmatter fields does the plugin enforce on a Flashcard note?
7. Which token should be inserted in a template to get a link to the index note?
8. Why do `<% ... %>` tags in a template remain inert after creation by the plugin?

## Appendix B — Acronyms

- **API** (*Application Programming Interface*): programming surface exposed by Obsidian to plugins (`Plugin`, `Vault` classes, etc.).
- **YAML** (*YAML Ain't Markup Language*): serialization language used for the frontmatter of Obsidian notes.
- **CTA** (*Call To Action*): in the Obsidian API, the highlighted button style (`setCta()`), used for the "Create" button.
- **ID** (*Identifier*): here, the timestamped identifier `YYYYMMDDHHmm` shared by all notes of a set.
- **UI** (*User Interface*): the plugin's input modals and settings panel.
- **LLM** (*Large Language Model*): conversational AI model (ChatGPT, Claude, Lumo…), the typical source of resource notes.
