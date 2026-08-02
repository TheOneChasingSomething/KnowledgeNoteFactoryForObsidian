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

**"Set status — project or task (Pending / Pause)" (v1.6, extended to tasks in v1.9.1).** The modal prefills the active note when it looks like a project or a task (projects/tasks folder, or a `project`/`task` frontmatter block), otherwise offers the same `[[`-style field. The note kind is detected automatically — a `task` block or a `Task-Note` tag makes it a task — and the status is written to the right key: `task.status` for tasks, `project.status` for projects (earlier versions wrongly injected a `project` block into task notes; the command now also repairs that pollution by deleting a `project` block that only carries a status on a task note). Applying a status does two things: it sets the status in the frontmatter through Obsidian's `processFrontMatter` API (formatting-safe), then moves the project's **bookmark** using the core Bookmarks plugin — `Pending` files it under the bookmark group **`4 - InProgress`**, `Pause` under **`3 - OnHold`** (both group names configurable). Group titles are matched **case-insensitively and recursively at any depth** of the bookmark tree (v1.8.1) — an existing `4 - InProgress` group, even nested inside a parent group, is reused rather than duplicated. On a status change the bookmark is removed from **every** group carrying the other status (and from duplicates of the target), then added exactly once; groups are only created at the root when nothing matches, and other bookmarks are left untouched. Two companion commands, **"Set current note to Pending"** and **"Set current note to Pause"** (v1.10), skip the modal entirely and apply the status directly to the note being edited — same auto-detection and bookmark move — so a status change on the open note is one shortcut away; they are disabled when no markdown note is active. If the core Bookmarks plugin is disabled, the frontmatter is still updated and a notice says no bookmark was moved.

**"Initialize structure (folders, templates, bookmarks)" (v1.7).** One idempotent setup command that reads the current settings and creates everything the plugin expects, without ever touching what already exists: the whole folder tree (the six `5_Knowledges` subfolders, `0_inbox`, `6_Projects`, `Ressources/Templates`, plus a configurable extra list defaulting to `2_References`, `4_Permanent`, `5_Knowledges`, `6_Projects`, `Ressources/Images`), a starter file for each missing configured template (frontmatter skeletons matching the vault's conventions, hosting the `{{…}}` tokens; the shared `permanent-note_template` is created once), and the bookmark groups — `4 - InProgress` / `3 - OnHold` plus a configurable extra list defaulting to `0 - DashBoard` and `1 - Knowledge`, created in sorted order (0, 1, 3, 4). A summary notice reports how many folders, templates and groups were created — or that the structure was already in place. Useful on a fresh vault, on a new machine, or after renaming things in the settings.

**"Check & normalize frontmatter" (v1.9).** Scans the frontmatter of every note in the vault and fixes three families of drift, with a **Check** button (report only, nothing written) and a **Normalize** button (writes through `processFrontMatter`, one file at a time, only where something changes). Rules: **statuses** (`status`, `project.status`, `task.status`) get their first letter capitalized (`pending` → `Pending`); **types** (`type`, `project.type`, `task.type`) are matched case-insensitively against a configurable canonical list (`Coding, VibeCoding, Challenge, Research, Knowledge, Config, Tooling`) with an `-ing` bridge (`researching` → `Research`), unknown values falling back to simple capitalization; **tags** (`tags` and `Tags` keys) are mapped to their English form via a configurable `from=to` map (`ressources-note` → `resources-note` — English is preferred) then a configurable **removal list** strips unwanted tags (default: `resource`, `resources-note`), and finally the tags are deduplicated case-insensitively. Mapping runs before removal, so a French tag like `ressources-note` is first converted to `resources-note` and then removed if listed. The results pane lists each affected note with its changes. The default tags of new resource notes are now just `literature-note` and `resource-note`, consistent with the removal list.

## 5. Video Notes Manager launcher (v1.12, desktop only)

Three commands drive the external [ObsidianVideoNotesManager](https://github.com/TheOneChasingSomething/ObsidianVideoNotesManager) Python script from Obsidian, launching it in a real terminal via Node's `child_process` (available in the desktop app's Electron runtime — the commands are hidden on mobile):

- **"open interactive menu (TUI)"** — runs the base command with no arguments, so the script's Typer menu appears in the terminal.
- **"run with arguments…"** — a modal where you type CLI arguments (`download video "URL"`, `download playlist PLxxx --max-videos 50`, …) appended to the base command.
- **"download URL from clipboard"** — reads the clipboard, classifies the URL (YouTube watch/short → `video`, YouTube `list=` → `playlist`, anything else → `article`) and runs the matching subcommand; the URL is POSIX-quoted so shell metacharacters cannot be injected.

Configuration lives in the **Video Notes Manager** settings section: the project folder (the repo, used as working directory, `~` expanded), the base command (default `source venv/bin/activate && python3 main.py`), the shell, the terminal emulator (presets for `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`, `kitty`, `alacritty`, `x-terminal-emulator`, or a custom binary + flags), and a *keep terminal open* toggle. Clipboard URLs are safely quoted; the *run with arguments* field is passed to the shell verbatim (expert mode). A failed launch (wrong terminal binary) surfaces as a notice.

## 6. Settings panel

Everything is configurable under **Settings → Knowledge Note Factory**: **Projects & tasks** section (project template, task-list heading, Pending/Pause bookmark groups, tasks folder, task template), template folder, identifier and date formats, defaults of the `project` block, and — for each of the six types — default activation, destination folder and template name. **Resource notes** section: inbox folder (`0_inbox`), projects folder used for note creation and suggestion scoping (`6_Projects` by default), optional resource template, default TrustLevel, author list, tag-generating keywords and fixed tags, plus the **Normalization** section (canonical types, tag map, tags to remove).

## 7. Known limitations

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
