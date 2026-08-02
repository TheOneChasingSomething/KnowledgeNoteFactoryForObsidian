'use strict';

/*
 * Knowledge Note Factory — Obsidian plugin
 * Creates, in a single command, a set of linked notes (Index, Flashcard,
 * CheatSheet, Gist, Slides, Groom) in the 5_Knowledges tree, from the
 * templates in Ressources/Templates (paths and names configurable in the
 * plugin settings). Also creates resource notes filed into 0_inbox and
 * linked back to their project and knowledge-index notes.
 *
 * Written in plain JavaScript: no build step required — drop main.js +
 * manifest.json into .obsidian/plugins/knowledge-note-factory/
 */

var obsidian = require('obsidian');

var TYPES = ['index', 'flashcard', 'cheatsheet', 'gist', 'slides', 'groom'];

var LABELS = {
  index: 'Index',
  flashcard: 'Flashcard',
  cheatsheet: 'CheatSheet',
  gist: 'Gist',
  slides: 'Slides',
  groom: 'Groom'
};

/* File-name decoration by note type. */
function decorate(type, name) {
  switch (type) {
    case 'index':      return '{{ ' + name + ' }}';
    case 'flashcard':  return '== ' + name + ' ==';
    case 'cheatsheet': return '"" ' + name + ' ""';
    case 'gist':       return '@@ ' + name + ' @@';
    case 'slides':     return '** ' + name + ' **';
    case 'groom':      return ';; ' + name + ' ;;';
    case 'project':    return '~~ ' + name + ' ~~';
    default:           return name;
  }
}

/* Optional replacement of characters forbidden on Windows / problematic
 * for sync ( * " \ / : < > | ? ). The full-width equivalents (＊ ＂)
 * preserve the look of the naming scheme. */
function sanitizeBase(base, enabled) {
  if (!enabled) return base;
  return base
    .replace(/\*/g, '＊')
    .replace(/"/g, '＂')
    .replace(/[\\/:<>|?]/g, '-');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitCsv(s) {
  return (s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}

/* "202604270829h - ~~ X ~~" -> "202604270829h" (first token before " - "). */
function idFromBase(base) {
  var m = String(base).match(/^(\S+)\s+-\s/);
  return m ? m[1] : '';
}

/* 0 -> a, 25 -> z, 26 -> aa, … (bijective base 26). */
function letterSuffix(n) {
  var s = '';
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/* "202601201033 - {{ GIT }}" -> "GIT" (strips the id and decorations). */
function subjectFromBase(base) {
  var s = String(base).replace(/^\S+\s*-\s*/, '');
  s = s.replace(/[{}=@*;~＂＊"]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

function headingInfo(line) {
  var m = line.match(/^(#{1,6})\s+(.*)$/);
  if (m) return { level: m[1].length, text: m[2] };
  return null;
}

/* Strips wiki-link brackets, emphasis marks and leading symbols/emojis. */
function normalizeHeadingText(t) {
  return String(t)
    .replace(/\[\[|\]\]/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/^[^0-9A-Za-z\u00C0-\u024F]+/, '')
    .trim()
    .toLowerCase();
}

/* Exact match, or (unless exactOnly) prefix followed by a non-letter
 * boundary — so "LLM :" or "LLM (conversations)" still match "LLM". */
function headingTextMatches(text, wanted, exactOnly) {
  var t = normalizeHeadingText(text);
  if (t === wanted) return true;
  if (exactOnly) return false;
  if (t.indexOf(wanted) === 0) {
    var next = t.charAt(wanted.length);
    return next === '' || !/[0-9a-z\u00C0-\u024F]/.test(next);
  }
  return false;
}

/* Recognizes a section title on a line, in three forms:
 * 1. ATX heading (## LLM) — tolerant text match;
 * 2. standalone bold line (**LLM**) — tolerant text match;
 * 3. bare text line — exact match only, to avoid catching prose.
 * Non-ATX titles get a synthetic level of parentLevel + 1. */
function matchHeadingLine(line, wanted, parentLevel) {
  var h = headingInfo(line);
  if (h) {
    if (headingTextMatches(h.text, wanted, false)) return { level: h.level, atx: true };
    return null;
  }
  var b = line.match(/^\s*(\*\*|__)(.+?)\1\s*$/);
  if (b && headingTextMatches(b[2], wanted, false)) {
    return { level: (parentLevel || 1) + 1, atx: false };
  }
  var t = line.trim();
  if (t && t.length <= 80 &&
      !/^([-*+>]\s|\d+[.)]\s|!?\[|#|`|\||---)/.test(t) &&
      headingTextMatches(t, wanted, true)) {
    return { level: (parentLevel || 1) + 1, atx: false };
  }
  return null;
}

/* "Ressources > LLM" -> ['Ressources', 'LLM'] (falls back if empty). */
function splitChain(str, fallback) {
  var parts = (str || '').split('>').map(function (x) { return x.trim(); }).filter(Boolean);
  return parts.length ? parts : fallback;
}

/* Obsidian-like [[ suggester attached to a plain text input: typing (with or
 * without the [[ prefix) pops file suggestions, scoped to a folder when it
 * exists, otherwise the whole vault. */
var FileSuggestClass = null;
if (obsidian.AbstractInputSuggest) {
  FileSuggestClass = /** @class */ (function (_super) {
    function FileSuggestClass(app, inputEl, folder, onPick) {
      var _this = _super.call(this, app, inputEl) || this;
      _this._app = app;
      _this._input = inputEl;
      _this._folder = folder ? obsidian.normalizePath(folder) : '';
      _this._onPick = onPick || null;
      return _this;
    }
    if (Object.setPrototypeOf) Object.setPrototypeOf(FileSuggestClass, _super);
    FileSuggestClass.prototype = Object.create(_super.prototype);
    FileSuggestClass.prototype.constructor = FileSuggestClass;

    FileSuggestClass.prototype.getSuggestions = function (query) {
      var q = String(query || '')
        .replace(/^\s*\[\[/, '')
        .replace(/\]\]\s*$/, '')
        .toLowerCase();
      var all = this._app.vault.getMarkdownFiles();
      var folder = this._folder;
      var pool = folder
        ? all.filter(function (f) { return f.path.indexOf(folder + '/') === 0; })
        : all;
      if (!pool.length) pool = all; /* fallback: whole vault if the folder does not match */
      var out = pool.filter(function (f) {
        return f.basename.toLowerCase().indexOf(q) !== -1;
      });
      out.sort(function (a, b) { return b.basename.localeCompare(a.basename); });
      return out.slice(0, 50);
    };

    FileSuggestClass.prototype.renderSuggestion = function (file, el) {
      el.setText(file.basename);
    };

    FileSuggestClass.prototype.selectSuggestion = function (file) {
      this._input.value = file.basename;
      this._input.dispatchEvent(new Event('input'));
      if (this._onPick) this._onPick(file);
      this.close();
    };

    return FileSuggestClass;
  })(obsidian.AbstractInputSuggest);
}

function attachFileSuggest(app, inputEl, folder, onPick) {
  if (FileSuggestClass) new FileSuggestClass(app, inputEl, folder, onPick);
}

/* Removes every file bookmark pointing to path from a group (in place). */
function removeBookmarkPath(group, path) {
  if (!group || !group.items) return;
  for (var i = group.items.length - 1; i >= 0; i--) {
    var it = group.items[i];
    if (it && it.type === 'file' && it.path === path) group.items.splice(i, 1);
  }
}

/* Automatic tags: fixed tags + index subject + keywords detected in the content. */
function buildResourceTags(resourceSettings, indexBase, text) {
  var tags = [];
  var seen = {};
  function add(t) {
    if (t && !seen[t.toLowerCase()]) { tags.push(t); seen[t.toLowerCase()] = true; }
  }
  splitCsv(resourceSettings.fixedTags).forEach(add);
  if (indexBase) {
    var subj = subjectFromBase(indexBase);
    if (subj) add(subj.charAt(0).toUpperCase() + subj.slice(1).toLowerCase());
  }
  var hay = text || '';
  splitCsv(resourceSettings.keywords).forEach(function (kw) {
    if (new RegExp('\\b' + escapeRegExp(kw) + '\\b', 'i').test(hay)) add(kw);
  });
  return tags;
}

var RESOURCE_KEYS = ['Author', 'URL', 'Publication', 'Lecture', 'Project', 'Task',
  'Knowledge-index', 'TrustLevel', 'download', 'Tags', 'tags', 'rédaction'];

function resourceFrontmatter(ctx) {
  var lines = [];
  lines.push('Author: ' + (ctx.author || ''));
  lines.push('URL: ' + (ctx.url || ''));
  lines.push('Publication: ' + ctx.today);
  lines.push('Lecture: ' + ctx.today);
  lines.push('Project: ' + (ctx.projectBase ? '"[[' + ctx.projectBase + ']]"' : ''));
  lines.push('Task: ' + (ctx.task || ''));
  lines.push('Knowledge-index: ' + (ctx.indexBase ? '"[[' + ctx.indexBase + ']]"' : ''));
  lines.push('TrustLevel: ' + (ctx.trustLevel ? '"' + ctx.trustLevel + '"' : ''));
  lines.push('download:');
  lines.push('Tags:');
  ctx.tags.forEach(function (t) { lines.push('  - ' + t); });
  return lines;
}

var PROJECT_KEYS = ['rédaction', 'tags', 'project'];

function projectNoteFrontmatter(ctx) {
  var lines = [];
  lines.push('rédaction: ' + ctx.today);
  lines.push('tags:');
  lines.push('  - project-note');
  lines.push('project:');
  lines.push('  name: ' + (ctx.name || ''));
  lines.push('  parent: ' + (ctx.parent || 'None'));
  lines.push('  status: ' + (ctx.status || 'Pending'));
  lines.push('  type: ' + (ctx.type || ''));
  return lines;
}

var TASK_KEYS = ['rédaction', 'tags', 'production', 'task'];

function taskNoteFrontmatter(ctx) {
  var lines = [];
  lines.push('rédaction: ' + ctx.today);
  lines.push('tags:');
  lines.push('  - Task-Note');
  lines.push('production:');
  lines.push('task:');
  lines.push('  project: ' + (ctx.project || ''));
  lines.push('  status: ' + (ctx.status || 'Pending'));
  lines.push('  type: ' + (ctx.type || ''));
  return lines;
}

/* Built-in project body when no template is configured. */
var PROJECT_BODY_SKELETON = '## Objectifs\n\n## Liste des tâches\n\n## Notes\n\n## LLM\n';

/* Starter contents written by "Initialize structure" for missing templates.
 * The plugin regenerates the mandated frontmatter at note creation anyway,
 * so these mainly document each template and host the {{…}} tokens. */
var TPL_INDEX_STARTER = '---\nrédaction: {{date}}\ntags:\n  - project-knowledge-note\nproject:\n  name: {{name}}\n  parent: None\n  status: Pending\n  type: Knowledge\n---\n';
var TPL_FLASHCARD_STARTER = '---\nrédaction: {{date}}\nKnowledge-index: "{{index}}"\ntags:\n  - permanent-note\n  - flashcard-note\n---\n';
var TPL_CHEATSHEET_STARTER = '---\nrédaction: {{date}}\nKnowledge-index: "{{index}}"\ntags:\n  - permanent-note\n  - cheatsheet-note\n---\n';
var TPL_GIST_STARTER = '---\nrédaction: {{date}}\nKnowledge-index: "{{index}}"\ntags:\n  - permanent-note\n  - gist-note\n---\n\n## {{title}}\n';
var TPL_PERMANENT_STARTER = '---\nrédaction: {{date}}\nImpactScore:\ntags:\n  - permanent-note\n---\n\n# {{title}}\n\nindex links :\n- \n';
var TPL_RESOURCE_STARTER = '---\nAuthor: \nURL: \nPublication: {{date}}\nLecture: {{date}}\nProject: \nTask: \nKnowledge-index: \nTrustLevel: \ndownload:\nTags:\n  - literature-note\n  - ressources-note\n  - resource\n  - resource-note\n---\n';
var TPL_PROJECT_STARTER = '---\nrédaction: {{date}}\ntags:\n  - project-note\nproject:\n  name: {{name}}\n  parent: None\n  status: Pending\n  type: \n---\n\n' + PROJECT_BODY_SKELETON;
var TPL_TASK_STARTER = '---\nrédaction: {{date}}\ntags:\n  - Task-Note\nproduction:\ntask:\n  project: \n  status: Pending\n  type: \n---\n';

/* Walks the heading chain and returns how far it matched, plus the scope
 * [start, end) of the deepest matched heading and its level/kind. */
function findChain(lines, chain) {
  var start = 0;
  var end = lines.length;
  var level = 0;
  var atx = true;
  var matched = 0;

  for (var c = 0; c < chain.length; c++) {
    var wanted = normalizeHeadingText(chain[c]);
    var found = -1;
    var info = null;
    for (var i = start; i < end; i++) {
      var hm = matchHeadingLine(lines[i], wanted, level);
      if (hm) { found = i; info = hm; break; }
    }
    if (found === -1) break;
    /* Narrow the scope to this heading's content (ATX headings close it). */
    start = found + 1;
    var scopeEnd = end;
    for (var j = start; j < end; j++) {
      var h2 = headingInfo(lines[j]);
      if (h2 && h2.level <= info.level) { scopeEnd = j; break; }
    }
    end = scopeEnd;
    level = info.level;
    atx = info.atx;
    matched++;
  }
  return { matched: matched, start: start, end: end, level: level, atx: atx };
}

/* Inserts a bullet under a chain of headings (e.g. Ressources > LLM),
 * grouped after the last bullet by the same author.
 * Titles are matched tolerantly (ATX, bold or bare line, optional suffix);
 * if the full chain is missing, falls back to the last title found anywhere
 * in the note; only then are missing headings created. */
function insertIntoSection(content, bullet, chain, author) {
  var lines = content.split('\n');

  var sec = findChain(lines, chain);
  if (sec.matched < chain.length && chain.length > 1) {
    /* Fallback: look for the final title (e.g. LLM) anywhere in the note,
     * even when its parents are absent or named differently. */
    var alt = findChain(lines, [chain[chain.length - 1]]);
    if (alt.matched === 1) {
      sec = { matched: chain.length, start: alt.start, end: alt.end, level: alt.level, atx: alt.atx };
    }
  }

  if (sec.matched < chain.length) {
    /* Missing headings: created at the end of the deepest matched scope. */
    var toInsert = [];
    var curLevel = sec.level > 0 ? sec.level + 1 : 2;
    if (sec.end > 0 && lines[sec.end - 1] && lines[sec.end - 1].trim() !== '') toInsert.push('');
    for (var r = sec.matched; r < chain.length; r++) {
      toInsert.push(Array(Math.min(curLevel, 6) + 1).join('#') + ' ' + chain[r]);
      toInsert.push('');
      curLevel++;
    }
    toInsert.push(bullet);
    Array.prototype.splice.apply(lines, [sec.end, 0].concat(toInsert));
    return lines.join('\n');
  }

  var lastBullet = -1;
  var lastAuthorBullet = -1;
  var authorRe = author ? new RegExp('\\b' + escapeRegExp(author) + '\\s*-', 'i') : null;

  if (sec.atx) {
    /* ATX scope is reliable: scan the whole section. */
    for (var k = sec.start; k < sec.end; k++) {
      if (/^\s*[-*+]\s+\S/.test(lines[k])) {
        lastBullet = k;
        if (authorRe && authorRe.test(lines[k])) lastAuthorBullet = k;
      }
    }
  } else {
    /* Bold/bare titles do not bound a scope: only take the contiguous
     * list right after the title, and stop at the first other content
     * (which is likely the next pseudo-section). */
    var m = sec.start;
    while (m < sec.end && lines[m].trim() === '') m++;
    for (; m < sec.end; m++) {
      if (lines[m].trim() === '') continue;
      if (/^\s*[-*+]\s+\S/.test(lines[m])) {
        lastBullet = m;
        if (authorRe && authorRe.test(lines[m])) lastAuthorBullet = m;
      } else {
        break;
      }
    }
  }

  var pos;
  if (lastAuthorBullet !== -1) pos = lastAuthorBullet + 1;
  else if (lastBullet !== -1) pos = lastBullet + 1;
  else {
    pos = sec.start;
    while (pos < sec.end && lines[pos].trim() === '') pos++;
  }
  var insertArr = [bullet];
  var following = lines[pos];
  if (following !== undefined && following.trim() !== '' && !/^\s*[-*+]\s+/.test(following)) {
    insertArr.push('');
  }
  Array.prototype.splice.apply(lines, [pos, 0].concat(insertArr));
  return lines.join('\n');
}

var DEFAULT_SETTINGS = {
  templateFolder: 'Ressources/Templates',
  idFormat: 'YYYYMMDDHHmm',
  dateFormat: 'YYYY-MM-DD',
  openIndexAfterCreate: true,
  sanitizeFileNames: false,
  defaultParent: 'None',
  defaultStatus: 'Pending',
  defaultProjectType: 'Knowledge',
  resource: {
    inboxFolder: '0_inbox',
    projectFolder: '6_Projects',
    template: '',
    trustLevel: '',
    authors: 'ChatGPT, Claude, ClaudeIA, Claude IA, Lumo',
    projectChain: 'Ressources > LLM',
    indexChain: 'LLM',
    keywords: 'Git, GitHub, GitLab, TLS, HTTPS, SSH, MITM, CTF, Docker, Python, JavaScript, V8, Linux, Obsidian',
    fixedTags: 'literature-note, ressources-note, resource, resource-note'
  },
  project: {
    template: '',
    taskSection: 'Liste des tâches',
    pendingGroup: '4 - inProgress',
    pauseGroup: '3 - OnHold'
  },
  task: {
    folder: '6_Projects',
    template: ''
  },
  init: {
    extraFolders: '2_References, 4_Permanent, 5_Knowledges, 6_Projects, Ressources/Images',
    extraGroups: '0 - DashBoard, 1 - Knowledge'
  },
  types: {
    index:      { folder: '5_Knowledges/0 - Index',      template: 'index-note_template',      enabled: true },
    flashcard:  { folder: '5_Knowledges/1 - Flashcard',  template: 'flashcard_template',       enabled: true },
    cheatsheet: { folder: '5_Knowledges/2 - CheatSheet', template: 'cheatsheet-note_template', enabled: true },
    gist:       { folder: '5_Knowledges/3 - Gist',       template: 'gist_template',            enabled: true },
    slides:     { folder: '5_Knowledges/5 - Slides',     template: 'permanent-note_template',  enabled: true },
    groom:      { folder: '5_Knowledges/6 - Groom',      template: 'permanent-note_template',  enabled: true }
  }
};

/* ------------------------------------------------------------------ */
/* Template parsing and merging                                        */
/* ------------------------------------------------------------------ */

/* Splits a template into (frontmatter keys -> raw block, body). */
function splitTemplate(content) {
  var result = { keys: new Map(), body: '' };
  if (!content) return result;

  var m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) {
    result.body = content;
    return result;
  }
  var yaml = m[1];
  result.body = content.slice(m[0].length);

  var currentKey = null;
  var buf = [];
  var lines = yaml.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var km = line.match(/^([^\s#][^:]*?)\s*:/);
    if (km) {
      if (currentKey !== null) result.keys.set(currentKey, buf.join('\n'));
      currentKey = km[1].trim();
      buf = [line];
    } else if (currentKey !== null) {
      buf.push(line);
    }
  }
  if (currentKey !== null) result.keys.set(currentKey, buf.join('\n'));
  return result;
}

/* Frontmatter mandated by the spec, per note type. */
function specFrontmatter(type, ctx) {
  var lines = [];
  lines.push('rédaction: ' + ctx.today);

  if (type === 'index') {
    lines.push('tags:');
    lines.push('  - project-knowledge-note');
    lines.push('project:');
    lines.push('  name: ' + ctx.name);
    lines.push('  parent: ' + ctx.project.parent);
    lines.push('  status: ' + ctx.project.status);
    lines.push('  type: ' + ctx.project.type);
  } else if (type === 'flashcard' || type === 'cheatsheet' || type === 'gist') {
    lines.push('Knowledge-index: "[[' + ctx.indexBase + ']]"');
    lines.push('tags:');
    lines.push('  - permanent-note');
    lines.push('  - ' + type + '-note');
  } else { /* slides, groom */
    lines.push('ImpactScore:');
    lines.push('tags:');
    lines.push('  - permanent-note');
  }
  return lines;
}

function specKeys(type) {
  if (type === 'index') return ['rédaction', 'tags', 'project'];
  if (type === 'flashcard' || type === 'cheatsheet' || type === 'gist')
    return ['rédaction', 'Knowledge-index', 'tags'];
  return ['rédaction', 'ImpactScore', 'tags'];
}

/* Substitution tokens usable in template bodies. */
function replacePlaceholders(body, ctx) {
  return body
    .replace(/\{\{\s*<input>\s*\}\}/g, ctx.name)
    .replace(/<input>/g, ctx.name)
    .replace(/\{\{\s*title\s*\}\}/gi, ctx.base)
    .replace(/\{\{\s*id\s*\}\}/gi, ctx.id)
    .replace(/\{\{\s*date\s*\}\}/gi, ctx.today)
    .replace(/\{\{\s*name\s*\}\}/gi, ctx.name)
    .replace(/\{\{\s*index\s*\}\}/gi, '[[' + ctx.indexBase + ']]');
}

/* Builds a note's final content: mandated frontmatter + any extra
 * template keys + enriched template body. */
function renderNote(type, templateContent, ctx) {
  var split = splitTemplate(templateContent);
  var reserved = specKeys(type);

  var out = ['---'];
  out = out.concat(specFrontmatter(type, ctx));
  split.keys.forEach(function (block, key) {
    if (reserved.indexOf(key) === -1) out.push(block);
  });
  out.push('---');
  out.push('');

  var body = replacePlaceholders(split.body || '', ctx);

  if (type === 'gist') {
    var h2 = '## ' + ctx.base;
    if (body.indexOf(h2) === -1) body = h2 + '\n\n' + body;
  }
  if (type === 'slides') {
    var h1 = '# ' + ctx.base;
    if (body.indexOf(h1) === -1) body = h1 + '\n\nindex links :\n- \n\n' + body;
  }

  return out.join('\n') + body;
}

/* ------------------------------------------------------------------ */
/* Creation modal                                                      */
/* ------------------------------------------------------------------ */

var CreateKnowledgeModal = /** @class */ (function (_super) {
  function CreateKnowledgeModal(app, plugin) {
    var _this = _super.call(this, app) || this;
    _this.plugin = plugin;
    _this.name = '';
    _this.parent = plugin.settings.defaultParent;
    _this.status = plugin.settings.defaultStatus;
    _this.projectType = plugin.settings.defaultProjectType;
    _this.types = {};
    TYPES.forEach(function (t) {
      _this.types[t] = plugin.settings.types[t].enabled;
    });
    return _this;
  }
  if (Object.setPrototypeOf) Object.setPrototypeOf(CreateKnowledgeModal, _super);
  CreateKnowledgeModal.prototype = Object.create(_super.prototype);
  CreateKnowledgeModal.prototype.constructor = CreateKnowledgeModal;

  CreateKnowledgeModal.prototype.onOpen = function () {
    var self = this;
    var contentEl = this.contentEl;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'New knowledge note' });

    new obsidian.Setting(contentEl)
      .setName('Subject')
      .setDesc('Name inserted in titles, e.g. "AI"')
      .addText(function (t) {
        t.setPlaceholder('AI');
        t.onChange(function (v) { self.name = v; });
        t.inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') self.submit();
        });
        window.setTimeout(function () { t.inputEl.focus(); }, 10);
      });

    contentEl.createEl('h3', { text: 'Project (index note)' });

    new obsidian.Setting(contentEl).setName('parent').addText(function (t) {
      t.setValue(self.parent);
      t.onChange(function (v) { self.parent = v; });
    });
    new obsidian.Setting(contentEl).setName('status').addText(function (t) {
      t.setValue(self.status);
      t.onChange(function (v) { self.status = v; });
    });
    new obsidian.Setting(contentEl).setName('type').addText(function (t) {
      t.setValue(self.projectType);
      t.onChange(function (v) { self.projectType = v; });
    });

    contentEl.createEl('h3', { text: 'Notes to create' });
    TYPES.forEach(function (type) {
      new obsidian.Setting(contentEl)
        .setName(LABELS[type])
        .addToggle(function (tg) {
          tg.setValue(self.types[type]);
          tg.onChange(function (v) { self.types[type] = v; });
        });
    });

    new obsidian.Setting(contentEl).addButton(function (b) {
      b.setButtonText('Create').setCta().onClick(function () { self.submit(); });
    });
  };

  CreateKnowledgeModal.prototype.submit = function () {
    if (!this.name || !this.name.trim()) {
      new obsidian.Notice('Please enter a subject.');
      return;
    }
    var opts = {
      name: this.name.trim(),
      project: { parent: this.parent || 'None', status: this.status || 'Pending', type: this.projectType || 'Knowledge' },
      types: this.types
    };
    this.close();
    this.plugin.createSet(opts);
  };

  CreateKnowledgeModal.prototype.onClose = function () {
    this.contentEl.empty();
  };

  return CreateKnowledgeModal;
})(obsidian.Modal);

/* ------------------------------------------------------------------ */
/* Resource note creation modal                                        */
/* ------------------------------------------------------------------ */

var CreateResourceModal = /** @class */ (function (_super) {
  function CreateResourceModal(app, plugin) {
    var _this = _super.call(this, app) || this;
    _this.plugin = plugin;

    var active = app.workspace.getActiveFile();
    _this.activeFile = active && active.extension === 'md' ? active : null;
    _this.useActive = !!_this.activeFile;

    _this.author = '';
    _this.title = _this.activeFile ? _this.activeFile.basename : '';
    _this.url = '';
    _this.task = '';
    _this.trustLevel = plugin.settings.resource.trustLevel;
    _this.projectText = '';
    _this.indexText = '';

    /* If the active note's name is already "Author - Title", prefill. */
    if (_this.activeFile) {
      var base = _this.activeFile.basename;
      var authors = splitCsv(plugin.settings.resource.authors);
      for (var i = 0; i < authors.length; i++) {
        if (base.toLowerCase().indexOf(authors[i].toLowerCase() + ' - ') === 0) {
          _this.author = base.slice(0, authors[i].length);
          _this.title = base.slice(authors[i].length + 3);
          break;
        }
      }
    }
    return _this;
  }
  if (Object.setPrototypeOf) Object.setPrototypeOf(CreateResourceModal, _super);
  CreateResourceModal.prototype = Object.create(_super.prototype);
  CreateResourceModal.prototype.constructor = CreateResourceModal;

  CreateResourceModal.prototype.onOpen = function () {
    var self = this;
    var contentEl = this.contentEl;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'New resource note' });

    if (this.activeFile) {
      new obsidian.Setting(contentEl)
        .setName('Transform the active note')
        .setDesc('"' + this.activeFile.basename + '" — otherwise a new empty note is created')
        .addToggle(function (tg) {
          tg.setValue(self.useActive);
          tg.onChange(function (v) { self.useActive = v; });
        });
    }

    new obsidian.Setting(contentEl)
      .setName('Author')
      .setDesc('ChatGPT, Claude, ClaudeIA, Lumo… (configurable list)')
      .addText(function (t) {
        t.setValue(self.author);
        t.onChange(function (v) { self.author = v.trim(); });
        var dl = t.inputEl.ownerDocument.createElement('datalist');
        dl.id = 'knf-authors-list';
        splitCsv(self.plugin.settings.resource.authors).forEach(function (a) {
          var o = t.inputEl.ownerDocument.createElement('option');
          o.value = a;
          dl.appendChild(o);
        });
        t.inputEl.setAttribute('list', 'knf-authors-list');
        t.inputEl.parentElement.appendChild(dl);
      });

    new obsidian.Setting(contentEl)
      .setName('Title')
      .addText(function (t) {
        t.setValue(self.title);
        t.onChange(function (v) { self.title = v.trim(); });
      });

    new obsidian.Setting(contentEl)
      .setName('URL')
      .addText(function (t) {
        t.setPlaceholder('https://…');
        t.onChange(function (v) { self.url = v.trim(); });
      });

    new obsidian.Setting(contentEl)
      .setName('Project')
      .setDesc('Project note where the link is inserted (Ressources > LLM) — type its name or [[…]], suggestions as in Obsidian')
      .addText(function (t) {
        t.setPlaceholder('[[project note]]');
        t.onChange(function (v) { self.projectText = v; });
        attachFileSuggest(self.app, t.inputEl, self.plugin.settings.resource.projectFolder, function (file) {
          self.projectText = file.basename;
        });
      });

    new obsidian.Setting(contentEl)
      .setName('Knowledge-index')
      .setDesc('Index note where the link is inserted (LLM) — type its name or [[…]]')
      .addText(function (t) {
        t.setPlaceholder('[[index note]]');
        t.onChange(function (v) { self.indexText = v; });
        attachFileSuggest(self.app, t.inputEl, self.plugin.settings.types.index.folder, function (file) {
          self.indexText = file.basename;
        });
      });

    new obsidian.Setting(contentEl)
      .setName('Task')
      .addText(function (t) {
        t.onChange(function (v) { self.task = v.trim(); });
      });

    new obsidian.Setting(contentEl)
      .setName('TrustLevel')
      .addText(function (t) {
        t.setValue(self.trustLevel);
        t.onChange(function (v) { self.trustLevel = v.trim(); });
      });

    new obsidian.Setting(contentEl).addButton(function (b) {
      b.setButtonText('Create').setCta().onClick(function () { self.submit(); });
    });
  };

  CreateResourceModal.prototype.submit = function () {
    if (!this.title || !this.title.trim()) {
      new obsidian.Notice('Please enter a title.');
      return;
    }
    var projFile = this.plugin.resolveNote(this.projectText);
    if (this.projectText && this.projectText.trim() && !projFile) {
      new obsidian.Notice('Project note not found: ' + this.projectText);
    }
    var idxFile = this.plugin.resolveNote(this.indexText);
    if (this.indexText && this.indexText.trim() && !idxFile) {
      new obsidian.Notice('Knowledge-index note not found: ' + this.indexText);
    }
    var opts = {
      useActive: this.useActive,
      activeFile: this.useActive ? this.activeFile : null,
      author: this.author,
      title: this.title.trim(),
      url: this.url,
      task: this.task,
      trustLevel: this.trustLevel,
      projectPath: projFile ? projFile.path : '',
      indexPath: idxFile ? idxFile.path : ''
    };
    this.close();
    this.plugin.createResource(opts);
  };

  CreateResourceModal.prototype.onClose = function () {
    this.contentEl.empty();
  };

  return CreateResourceModal;
})(obsidian.Modal);

/* ------------------------------------------------------------------ */
/* Project note creation modal                                         */
/* ------------------------------------------------------------------ */

var CreateProjectModal = /** @class */ (function (_super) {
  function CreateProjectModal(app, plugin) {
    var _this = _super.call(this, app) || this;
    _this.plugin = plugin;
    _this.title = '';
    _this.shortName = '';
    _this.parent = plugin.settings.defaultParent;
    _this.status = plugin.settings.defaultStatus;
    _this.projectType = '';
    return _this;
  }
  if (Object.setPrototypeOf) Object.setPrototypeOf(CreateProjectModal, _super);
  CreateProjectModal.prototype = Object.create(_super.prototype);
  CreateProjectModal.prototype.constructor = CreateProjectModal;

  CreateProjectModal.prototype.onOpen = function () {
    var self = this;
    var contentEl = this.contentEl;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'New project note' });

    new obsidian.Setting(contentEl)
      .setName('Title')
      .setDesc('Used in the note name: <id> - ~~ Title ~~')
      .addText(function (t) {
        t.setPlaceholder('Config IA pour CTF');
        t.onChange(function (v) { self.title = v; });
        t.inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') self.submit();
        });
        window.setTimeout(function () { t.inputEl.focus(); }, 10);
      });

    new obsidian.Setting(contentEl)
      .setName('Short name')
      .setDesc('project.name in the frontmatter (default: title without spaces)')
      .addText(function (t) {
        t.setPlaceholder('ConfigCTFAI');
        t.onChange(function (v) { self.shortName = v.trim(); });
      });

    new obsidian.Setting(contentEl).setName('parent').addText(function (t) {
      t.setValue(self.parent);
      t.onChange(function (v) { self.parent = v.trim(); });
    });
    new obsidian.Setting(contentEl).setName('status').addText(function (t) {
      t.setValue(self.status);
      t.onChange(function (v) { self.status = v.trim(); });
    });
    new obsidian.Setting(contentEl).setName('type').addText(function (t) {
      t.setPlaceholder('Config, Knowledge, Tooling…');
      t.onChange(function (v) { self.projectType = v.trim(); });
    });

    new obsidian.Setting(contentEl).addButton(function (b) {
      b.setButtonText('Create').setCta().onClick(function () { self.submit(); });
    });
  };

  CreateProjectModal.prototype.submit = function () {
    if (!this.title || !this.title.trim()) {
      new obsidian.Notice('Please enter a title.');
      return;
    }
    var title = this.title.trim();
    var opts = {
      title: title,
      shortName: this.shortName || title.replace(/\s+/g, ''),
      parent: this.parent || 'None',
      status: this.status || 'Pending',
      type: this.projectType
    };
    this.close();
    this.plugin.createProject(opts);
  };

  CreateProjectModal.prototype.onClose = function () {
    this.contentEl.empty();
  };

  return CreateProjectModal;
})(obsidian.Modal);

/* ------------------------------------------------------------------ */
/* Task note creation modal                                            */
/* ------------------------------------------------------------------ */

var CreateTaskModal = /** @class */ (function (_super) {
  function CreateTaskModal(app, plugin) {
    var _this = _super.call(this, app) || this;
    _this.plugin = plugin;
    _this.title = '';
    _this.projectText = '';
    _this.status = plugin.settings.defaultStatus;
    _this.taskType = '';
    return _this;
  }
  if (Object.setPrototypeOf) Object.setPrototypeOf(CreateTaskModal, _super);
  CreateTaskModal.prototype = Object.create(_super.prototype);
  CreateTaskModal.prototype.constructor = CreateTaskModal;

  CreateTaskModal.prototype.onOpen = function () {
    var self = this;
    var contentEl = this.contentEl;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'New task note' });

    new obsidian.Setting(contentEl)
      .setName('Title')
      .setDesc('Used in the note name: <id> - Title')
      .addText(function (t) {
        t.setPlaceholder('Prise en main de claude-code');
        t.onChange(function (v) { self.title = v; });
        t.inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') self.submit();
        });
        window.setTimeout(function () { t.inputEl.focus(); }, 10);
      });

    new obsidian.Setting(contentEl)
      .setName('Project')
      .setDesc('The task is linked under the project note (task.project = its short name) — type its name or [[…]], suggestions as in Obsidian')
      .addText(function (t) {
        t.setPlaceholder('[[202605261545 - ~~ Config IA pour CTF ~~]]');
        t.onChange(function (v) { self.projectText = v; });
        attachFileSuggest(self.app, t.inputEl, self.plugin.settings.resource.projectFolder, function (file) {
          self.projectText = file.basename;
        });
      });

    new obsidian.Setting(contentEl).setName('status').addText(function (t) {
      t.setValue(self.status);
      t.onChange(function (v) { self.status = v.trim(); });
    });
    new obsidian.Setting(contentEl).setName('type').addText(function (t) {
      t.setPlaceholder('Tooling, Research…');
      t.onChange(function (v) { self.taskType = v.trim(); });
    });

    new obsidian.Setting(contentEl).addButton(function (b) {
      b.setButtonText('Create').setCta().onClick(function () { self.submit(); });
    });
  };

  CreateTaskModal.prototype.submit = function () {
    if (!this.title || !this.title.trim()) {
      new obsidian.Notice('Please enter a title.');
      return;
    }
    var projFile = this.plugin.resolveNote(this.projectText);
    if (this.projectText && this.projectText.trim() && !projFile) {
      new obsidian.Notice('Project note not found: ' + this.projectText);
    }
    var opts = {
      title: this.title.trim(),
      projectPath: projFile ? projFile.path : '',
      status: this.status || 'Pending',
      type: this.taskType
    };
    this.close();
    this.plugin.createTask(opts);
  };

  CreateTaskModal.prototype.onClose = function () {
    this.contentEl.empty();
  };

  return CreateTaskModal;
})(obsidian.Modal);

/* ------------------------------------------------------------------ */
/* Project status modal (Pending / Pause + bookmark move)              */
/* ------------------------------------------------------------------ */

var ProjectStatusModal = /** @class */ (function (_super) {
  function ProjectStatusModal(app, plugin) {
    var _this = _super.call(this, app) || this;
    _this.plugin = plugin;
    _this.status = 'Pending';
    _this.projectText = '';

    /* Prefill with the active note when it looks like a project note. */
    var active = app.workspace.getActiveFile();
    if (active && active.extension === 'md') {
      var folder = obsidian.normalizePath(plugin.settings.resource.projectFolder || '');
      var cache = app.metadataCache.getFileCache(active);
      var isProject = (folder && active.path.indexOf(folder + '/') === 0) ||
        (cache && cache.frontmatter && cache.frontmatter.project);
      if (isProject) _this.projectText = active.basename;
    }
    return _this;
  }
  if (Object.setPrototypeOf) Object.setPrototypeOf(ProjectStatusModal, _super);
  ProjectStatusModal.prototype = Object.create(_super.prototype);
  ProjectStatusModal.prototype.constructor = ProjectStatusModal;

  ProjectStatusModal.prototype.onOpen = function () {
    var self = this;
    var contentEl = this.contentEl;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Project status' });

    new obsidian.Setting(contentEl)
      .setName('Project')
      .setDesc('Type its name or [[…]], suggestions as in Obsidian')
      .addText(function (t) {
        t.setValue(self.projectText);
        t.setPlaceholder('[[202604270829h - ~~ Challenge MITM Https ~~]]');
        t.onChange(function (v) { self.projectText = v; });
        attachFileSuggest(self.app, t.inputEl, self.plugin.settings.resource.projectFolder, function (file) {
          self.projectText = file.basename;
        });
      });

    new obsidian.Setting(contentEl)
      .setName('Status')
      .setDesc('Pending → bookmark in "' + self.plugin.settings.project.pendingGroup +
        '" — Pause → bookmark in "' + self.plugin.settings.project.pauseGroup + '"')
      .addDropdown(function (d) {
        d.addOption('Pending', 'Pending');
        d.addOption('Pause', 'Pause');
        d.setValue(self.status);
        d.onChange(function (v) { self.status = v; });
      });

    new obsidian.Setting(contentEl).addButton(function (b) {
      b.setButtonText('Apply').setCta().onClick(function () { self.submit(); });
    });
  };

  ProjectStatusModal.prototype.submit = function () {
    var file = this.plugin.resolveNote(this.projectText);
    if (!file) {
      new obsidian.Notice('Project note not found: ' + (this.projectText || '(empty)'));
      return;
    }
    this.close();
    this.plugin.setProjectStatus(file, this.status);
  };

  ProjectStatusModal.prototype.onClose = function () {
    this.contentEl.empty();
  };

  return ProjectStatusModal;
})(obsidian.Modal);

/* ------------------------------------------------------------------ */
/* Settings tab                                                        */
/* ------------------------------------------------------------------ */

var FactorySettingTab = /** @class */ (function (_super) {
  function FactorySettingTab(app, plugin) {
    var _this = _super.call(this, app, plugin) || this;
    _this.plugin = plugin;
    return _this;
  }
  if (Object.setPrototypeOf) Object.setPrototypeOf(FactorySettingTab, _super);
  FactorySettingTab.prototype = Object.create(_super.prototype);
  FactorySettingTab.prototype.constructor = FactorySettingTab;

  FactorySettingTab.prototype.display = function () {
    var self = this;
    var containerEl = this.containerEl;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Knowledge Note Factory' });

    new obsidian.Setting(containerEl)
      .setName('Template folder')
      .setDesc('Path of the folder containing the template files')
      .addText(function (t) {
        t.setValue(self.plugin.settings.templateFolder);
        t.onChange(function (v) {
          self.plugin.settings.templateFolder = v.trim();
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('ID format')
      .setDesc('moment.js format — default: YYYYMMDDHHmm (e.g. 202605122044)')
      .addText(function (t) {
        t.setValue(self.plugin.settings.idFormat);
        t.onChange(function (v) {
          self.plugin.settings.idFormat = v.trim() || 'YYYYMMDDHHmm';
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('"rédaction" date format')
      .setDesc('moment.js format — default: YYYY-MM-DD')
      .addText(function (t) {
        t.setValue(self.plugin.settings.dateFormat);
        t.onChange(function (v) {
          self.plugin.settings.dateFormat = v.trim() || 'YYYY-MM-DD';
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Open the index note after creation')
      .addToggle(function (tg) {
        tg.setValue(self.plugin.settings.openIndexAfterCreate);
        tg.onChange(function (v) {
          self.plugin.settings.openIndexAfterCreate = v;
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Sanitize file names (Windows compatibility)')
      .setDesc('Replaces * and " with their full-width equivalents ＊ ＂ in file names. Enable if the vault is synced with a Windows machine.')
      .addToggle(function (tg) {
        tg.setValue(self.plugin.settings.sanitizeFileNames);
        tg.onChange(function (v) {
          self.plugin.settings.sanitizeFileNames = v;
          self.plugin.saveSettings();
        });
      });

    containerEl.createEl('h3', { text: 'Default values of the project block (index)' });

    var projDefaults = [
      ['defaultParent', 'parent'],
      ['defaultStatus', 'status'],
      ['defaultProjectType', 'type']
    ];
    projDefaults.forEach(function (pair) {
      new obsidian.Setting(containerEl).setName(pair[1]).addText(function (t) {
        t.setValue(self.plugin.settings[pair[0]]);
        t.onChange(function (v) {
          self.plugin.settings[pair[0]] = v.trim();
          self.plugin.saveSettings();
        });
      });
    });

    containerEl.createEl('h3', { text: 'Resource notes' });

    var resFields = [
      ['inboxFolder', 'Inbox folder', 'Folder where resource notes are created or moved'],
      ['projectFolder', 'Projects folder', 'Folder where project notes are created, and used to scope note suggestions'],
      ['template', 'Resource template', 'Template name in the template folder (empty: none)'],
      ['trustLevel', 'Default TrustLevel', 'Initial value of the TrustLevel field'],
      ['authors', 'Suggested authors', 'Comma-separated list, used for input assistance and link grouping'],
      ['projectChain', 'Project note headings', "Heading chain in the project note, separated by '>' (default: Ressources > LLM)"],
      ['indexChain', 'Index note headings', "Heading chain in the knowledge-index note (default: LLM)"],
      ['keywords', 'Keywords → tags', 'Words searched in the title and content to generate automatic tags'],
      ['fixedTags', 'Fixed tags', 'Tags added to every resource note']
    ];
    resFields.forEach(function (f) {
      new obsidian.Setting(containerEl).setName(f[1]).setDesc(f[2]).addText(function (t) {
        t.setValue(self.plugin.settings.resource[f[0]]);
        t.onChange(function (v) {
          self.plugin.settings.resource[f[0]] = v;
          self.plugin.saveSettings();
        });
      });
    });

    containerEl.createEl('h3', { text: 'Projects & tasks' });

    new obsidian.Setting(containerEl)
      .setName('Project template')
      .setDesc('Template for project notes (empty: built-in skeleton Objectifs / Liste des tâches / Notes / LLM)')
      .addText(function (t) {
        t.setValue(self.plugin.settings.project.template);
        t.onChange(function (v) {
          self.plugin.settings.project.template = v.trim();
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Task-list heading')
      .setDesc("Heading in the project note where task links are inserted (chain separated by '>')")
      .addText(function (t) {
        t.setValue(self.plugin.settings.project.taskSection);
        t.onChange(function (v) {
          self.plugin.settings.project.taskSection = v;
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Bookmark group — Pending')
      .setDesc('Bookmarks group receiving projects set to Pending')
      .addText(function (t) {
        t.setValue(self.plugin.settings.project.pendingGroup);
        t.onChange(function (v) {
          self.plugin.settings.project.pendingGroup = v.trim();
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Bookmark group — Pause')
      .setDesc('Bookmarks group receiving projects set to Pause')
      .addText(function (t) {
        t.setValue(self.plugin.settings.project.pauseGroup);
        t.onChange(function (v) {
          self.plugin.settings.project.pauseGroup = v.trim();
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Tasks folder')
      .setDesc('Folder where task notes are created')
      .addText(function (t) {
        t.setValue(self.plugin.settings.task.folder);
        t.onChange(function (v) {
          self.plugin.settings.task.folder = v.trim();
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Task template')
      .setDesc('Template for task notes (empty: none)')
      .addText(function (t) {
        t.setValue(self.plugin.settings.task.template);
        t.onChange(function (v) {
          self.plugin.settings.task.template = v.trim();
          self.plugin.saveSettings();
        });
      });

    containerEl.createEl('h3', { text: 'Initialization' });

    new obsidian.Setting(containerEl)
      .setName('Extra folders')
      .setDesc('Comma-separated folders also created by "Initialize structure"')
      .addText(function (t) {
        t.setValue(self.plugin.settings.init.extraFolders);
        t.onChange(function (v) {
          self.plugin.settings.init.extraFolders = v;
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Extra bookmark groups')
      .setDesc('Comma-separated bookmark groups also created by "Initialize structure"')
      .addText(function (t) {
        t.setValue(self.plugin.settings.init.extraGroups);
        t.onChange(function (v) {
          self.plugin.settings.init.extraGroups = v;
          self.plugin.saveSettings();
        });
      });

    containerEl.createEl('h3', { text: 'Note types' });

    TYPES.forEach(function (type) {
      containerEl.createEl('h4', { text: LABELS[type] });

      new obsidian.Setting(containerEl)
        .setName('Enabled by default')
        .addToggle(function (tg) {
          tg.setValue(self.plugin.settings.types[type].enabled);
          tg.onChange(function (v) {
            self.plugin.settings.types[type].enabled = v;
            self.plugin.saveSettings();
          });
        });

      new obsidian.Setting(containerEl)
        .setName('Destination folder')
        .addText(function (t) {
          t.setValue(self.plugin.settings.types[type].folder);
          t.onChange(function (v) {
            self.plugin.settings.types[type].folder = v.trim();
            self.plugin.saveSettings();
          });
        });

      new obsidian.Setting(containerEl)
        .setName('Template')
        .setDesc('File name in the template folder (with or without .md)')
        .addText(function (t) {
          t.setValue(self.plugin.settings.types[type].template);
          t.onChange(function (v) {
            self.plugin.settings.types[type].template = v.trim();
            self.plugin.saveSettings();
          });
        });
    });
  };

  return FactorySettingTab;
})(obsidian.PluginSettingTab);

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

var KnowledgeNoteFactory = /** @class */ (function (_super) {
  function KnowledgeNoteFactory() {
    return (_super !== null && _super.apply(this, arguments)) || this;
  }
  if (Object.setPrototypeOf) Object.setPrototypeOf(KnowledgeNoteFactory, _super);
  KnowledgeNoteFactory.prototype = Object.create(_super.prototype);
  KnowledgeNoteFactory.prototype.constructor = KnowledgeNoteFactory;

  KnowledgeNoteFactory.prototype.onload = async function () {
    await this.loadSettings();
    var self = this;

    this.addCommand({
      id: 'create-knowledge-set',
      name: 'Create a knowledge note set',
      callback: function () {
        new CreateKnowledgeModal(self.app, self).open();
      }
    });

    this.addCommand({
      id: 'create-resource-note',
      name: 'Create a resource note',
      callback: function () {
        new CreateResourceModal(self.app, self).open();
      }
    });

    this.addCommand({
      id: 'create-project-note',
      name: 'Create a project note',
      callback: function () {
        new CreateProjectModal(self.app, self).open();
      }
    });

    this.addCommand({
      id: 'create-task-note',
      name: 'Create a task note',
      callback: function () {
        new CreateTaskModal(self.app, self).open();
      }
    });

    this.addCommand({
      id: 'set-project-status',
      name: 'Set project status (Pending / Pause)',
      callback: function () {
        new ProjectStatusModal(self.app, self).open();
      }
    });

    this.addCommand({
      id: 'init-structure',
      name: 'Initialize structure (folders, templates, bookmarks)',
      callback: function () {
        self.initializeStructure();
      }
    });

    this.addRibbonIcon('library', 'Knowledge Note Factory', function () {
      new CreateKnowledgeModal(self.app, self).open();
    });

    this.addSettingTab(new FactorySettingTab(this.app, this));
  };

  KnowledgeNoteFactory.prototype.loadSettings = async function () {
    var stored = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    this.settings.types = {};
    for (var i = 0; i < TYPES.length; i++) {
      var t = TYPES[i];
      this.settings.types[t] = Object.assign(
        {},
        DEFAULT_SETTINGS.types[t],
        (stored.types && stored.types[t]) || {}
      );
    }
    this.settings.resource = Object.assign(
      {},
      DEFAULT_SETTINGS.resource,
      stored.resource || {}
    );
    this.settings.project = Object.assign(
      {},
      DEFAULT_SETTINGS.project,
      stored.project || {}
    );
    this.settings.task = Object.assign(
      {},
      DEFAULT_SETTINGS.task,
      stored.task || {}
    );
    this.settings.init = Object.assign(
      {},
      DEFAULT_SETTINGS.init,
      stored.init || {}
    );
  };

  KnowledgeNoteFactory.prototype.saveSettings = async function () {
    await this.saveData(this.settings);
  };

  KnowledgeNoteFactory.prototype.ensureFolder = async function (path) {
    var parts = obsidian.normalizePath(path).split('/');
    var cur = '';
    for (var i = 0; i < parts.length; i++) {
      cur = cur ? cur + '/' + parts[i] : parts[i];
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch (e) { /* already created concurrently */ }
      }
    }
  };

  KnowledgeNoteFactory.prototype.loadTemplate = async function (templateName) {
    if (!templateName) return null;
    var fileName = templateName.endsWith('.md') ? templateName : templateName + '.md';
    var full = obsidian.normalizePath(this.settings.templateFolder + '/' + fileName);
    var f = this.app.vault.getAbstractFileByPath(full);
    if (f instanceof obsidian.TFile) {
      return await this.app.vault.read(f);
    }
    new obsidian.Notice('Template not found: ' + full + ' — minimal frontmatter used.');
    return null;
  };

  KnowledgeNoteFactory.prototype.createSet = async function (opts) {
    var s = this.settings;
    var id = window.moment().format(s.idFormat || 'YYYYMMDDHHmm');
    var today = window.moment().format(s.dateFormat || 'YYYY-MM-DD');
    var name = opts.name;

    var indexBase = sanitizeBase(id + ' - ' + decorate('index', name), s.sanitizeFileNames);

    var indexFile = null;
    var createdCount = 0;

    for (var i = 0; i < TYPES.length; i++) {
      var type = TYPES[i];
      if (!opts.types[type]) continue;

      var conf = s.types[type];
      var base = sanitizeBase(id + ' - ' + decorate(type, name), s.sanitizeFileNames);
      var folder = obsidian.normalizePath(conf.folder);
      await this.ensureFolder(folder);

      var path = obsidian.normalizePath(folder + '/' + base + '.md');
      if (this.app.vault.getAbstractFileByPath(path)) {
        new obsidian.Notice('Already exists, skipped: ' + path);
        continue;
      }

      var tpl = await this.loadTemplate(conf.template);
      var ctx = {
        id: id,
        today: today,
        name: name,
        base: base,
        indexBase: indexBase,
        project: opts.project
      };
      var content = renderNote(type, tpl, ctx);

      try {
        var file = await this.app.vault.create(path, content);
        createdCount++;
        if (type === 'index') indexFile = file;
      } catch (e) {
        new obsidian.Notice(
          'Creation failed: ' + path + ' — ' + e.message +
          ' (if the message mentions the characters * or ", enable "Sanitize file names" in the settings)'
        );
      }
    }

    new obsidian.Notice(createdCount + ' note(s) created — id ' + id);

    if (indexFile && s.openIndexAfterCreate) {
      await this.app.workspace.getLeaf(false).openFile(indexFile);
    }
  };

  /* Creates every folder, template file and bookmark group the plugin
   * expects — idempotent: anything that already exists is left untouched. */
  KnowledgeNoteFactory.prototype.initializeStructure = async function () {
    var s = this.settings;
    var nf = 0;
    var nt = 0;
    var ng = 0;

    /* 1. Folder tree */
    var folders = [];
    for (var i = 0; i < TYPES.length; i++) folders.push(s.types[TYPES[i]].folder);
    folders.push(s.resource.inboxFolder, s.resource.projectFolder, s.task.folder, s.templateFolder);
    folders = folders.concat(splitCsv(s.init.extraFolders));
    var seen = {};
    for (var j = 0; j < folders.length; j++) {
      if (!folders[j]) continue;
      var f = obsidian.normalizePath(folders[j]);
      if (seen[f]) continue;
      seen[f] = true;
      if (!this.app.vault.getAbstractFileByPath(f)) {
        await this.ensureFolder(f);
        nf++;
      }
    }

    /* 2. Template files (missing ones only) */
    var starters = {};
    function addStarter(name, content) {
      if (!name) return;
      var file = name.endsWith('.md') ? name : name + '.md';
      if (!starters[file]) starters[file] = content;
    }
    addStarter(s.types.index.template, TPL_INDEX_STARTER);
    addStarter(s.types.flashcard.template, TPL_FLASHCARD_STARTER);
    addStarter(s.types.cheatsheet.template, TPL_CHEATSHEET_STARTER);
    addStarter(s.types.gist.template, TPL_GIST_STARTER);
    addStarter(s.types.slides.template, TPL_PERMANENT_STARTER);
    addStarter(s.types.groom.template, TPL_PERMANENT_STARTER);
    addStarter(s.resource.template, TPL_RESOURCE_STARTER);
    addStarter(s.project.template, TPL_PROJECT_STARTER);
    addStarter(s.task.template, TPL_TASK_STARTER);

    for (var name in starters) {
      if (!Object.prototype.hasOwnProperty.call(starters, name)) continue;
      var p = obsidian.normalizePath(s.templateFolder + '/' + name);
      if (!this.app.vault.getAbstractFileByPath(p)) {
        try {
          await this.app.vault.create(p, starters[name]);
          nt++;
        } catch (e) {
          new obsidian.Notice('Template creation failed: ' + p + ' — ' + e.message);
        }
      }
    }

    /* 3. Bookmark groups */
    var bk = this.getBookmarksInstance();
    if (bk) {
      var groups = [s.project.pendingGroup, s.project.pauseGroup]
        .concat(splitCsv(s.init.extraGroups));
      groups.sort();
      var seenG = {};
      for (var gi = 0; gi < groups.length; gi++) {
        var title = groups[gi];
        if (!title || seenG[title]) continue;
        seenG[title] = true;
        if (!this.findBookmarkGroup(bk, title, false)) {
          this.findBookmarkGroup(bk, title, true);
          ng++;
        }
      }
      if (ng > 0) {
        if (typeof bk.saveData === 'function') bk.saveData();
        if (typeof bk.trigger === 'function') bk.trigger('changed');
      }
    } else {
      new obsidian.Notice('Core Bookmarks plugin is disabled — bookmark groups were not created.');
    }

    if (nf + nt + ng === 0) {
      new obsidian.Notice('Structure already in place — nothing to create.');
    } else {
      new obsidian.Notice('Structure ready: ' + nf + ' folder(s), ' + nt +
        ' template(s), ' + ng + ' bookmark group(s) created.');
    }
  };

  /* Instance of the core Bookmarks plugin, or null when disabled. */
  KnowledgeNoteFactory.prototype.getBookmarksInstance = function () {
    var ip = this.app.internalPlugins;
    if (!ip) return null;
    if (typeof ip.getEnabledPluginById === 'function') {
      var inst = ip.getEnabledPluginById('bookmarks');
      if (inst) return inst;
    }
    var p = typeof ip.getPluginById === 'function'
      ? ip.getPluginById('bookmarks')
      : (ip.plugins && ip.plugins.bookmarks);
    if (!p || p.enabled === false) return null;
    return p.instance || null;
  };

  /* Root-level bookmark group by title; created on demand when create=true. */
  KnowledgeNoteFactory.prototype.findBookmarkGroup = function (bk, title, create) {
    var items = bk.items || (bk.items = []);
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].type === 'group' && items[i].title === title) return items[i];
    }
    if (!create) return null;
    var group = { type: 'group', ctime: Date.now(), title: title, items: [] };
    items.push(group);
    return group;
  };

  /* Sets project.status in the frontmatter and moves the project's bookmark
   * into the group matching the status (Pending -> pendingGroup,
   * Pause -> pauseGroup), removing it from the other group. */
  KnowledgeNoteFactory.prototype.setProjectStatus = async function (file, status) {
    var s = this.settings;

    try {
      await this.app.fileManager.processFrontMatter(file, function (fm) {
        if (!fm.project || typeof fm.project !== 'object') fm.project = {};
        fm.project.status = status;
      });
    } catch (e) {
      new obsidian.Notice('Frontmatter update failed: ' + e.message);
      return;
    }

    var targetTitle = status === 'Pause' ? s.project.pauseGroup : s.project.pendingGroup;
    var otherTitle = status === 'Pause' ? s.project.pendingGroup : s.project.pauseGroup;

    var bk = this.getBookmarksInstance();
    if (!bk) {
      new obsidian.Notice('Status set to ' + status +
        ' — core Bookmarks plugin is disabled, no bookmark was moved.');
      return;
    }

    var target = this.findBookmarkGroup(bk, targetTitle, true);
    var other = this.findBookmarkGroup(bk, otherTitle, false);
    removeBookmarkPath(other, file.path);

    var already = false;
    var items = target.items || (target.items = []);
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].type === 'file' && items[i].path === file.path) { already = true; break; }
    }
    if (!already) items.push({ type: 'file', ctime: Date.now(), path: file.path });

    if (typeof bk.saveData === 'function') bk.saveData();
    if (typeof bk.trigger === 'function') bk.trigger('changed');

    new obsidian.Notice('"' + file.basename + '" → ' + status +
      ' (bookmarked in "' + targetTitle + '")');
  };

  /* Child id derived from a parent id: a parent ending with a letter gets
   * numeric suffixes (…h -> …h1, …h2), a parent ending with a digit gets
   * letter suffixes (…5 -> …5a, …5b). Returns the first suffix not already
   * used as the id token of an existing note. */
  KnowledgeNoteFactory.prototype.nextChildId = function (parentId) {
    var numeric = /[0-9]$/.test(parentId);
    var used = {};
    var files = this.app.vault.getMarkdownFiles();
    for (var i = 0; i < files.length; i++) {
      var tok = idFromBase(files[i].basename);
      if (tok && tok.indexOf(parentId) === 0 && tok.length > parentId.length) {
        used[tok] = true;
      }
    }
    for (var n = 0; n < 10000; n++) {
      var suffix = numeric ? letterSuffix(n) : String(n + 1);
      var cand = parentId + suffix;
      if (!used[cand]) return cand;
    }
    return parentId + '-' + window.moment().format('HHmmss');
  };

  /* Resolves "[[Note]]", "[[Note|alias]]" or a bare name to a file, the way
   * Obsidian resolves link text; falls back to a case-insensitive basename match. */
  KnowledgeNoteFactory.prototype.resolveNote = function (text) {
    var t = String(text || '').trim()
      .replace(/^\[\[/, '')
      .replace(/\]\]$/, '')
      .trim();
    if (!t) return null;
    var pipe = t.indexOf('|');
    if (pipe !== -1) t = t.slice(0, pipe).trim();
    var f = this.app.metadataCache.getFirstLinkpathDest(t, '');
    if (f) return f;
    var lower = t.toLowerCase();
    var files = this.app.vault.getMarkdownFiles();
    for (var i = 0; i < files.length; i++) {
      if (files[i].basename.toLowerCase() === lower) return files[i];
    }
    return null;
  };

  /* Markdown notes of a folder, sorted by descending name (recent ids first). */
  KnowledgeNoteFactory.prototype.listNotesIn = function (folder) {
    if (!folder) return [];
    var prefix = obsidian.normalizePath(folder);
    var files = this.app.vault.getMarkdownFiles().filter(function (f) {
      return f.path.indexOf(prefix + '/') === 0;
    });
    files.sort(function (a, b) { return b.basename.localeCompare(a.basename); });
    return files;
  };

  /* Inserts "- [[note]]" into a file, under the given heading chain. */
  KnowledgeNoteFactory.prototype.insertResourceLink = async function (file, noteName, author, chain) {
    var content = await this.app.vault.read(file);
    if (content.indexOf('[[' + noteName + ']]') !== -1 ||
        content.indexOf('[[' + noteName + '|') !== -1) {
      return; /* link already present */
    }
    var updated = insertIntoSection(content, '- [[' + noteName + ']]', chain, author);
    if (updated !== content) await this.app.vault.modify(file, updated);
  };

  KnowledgeNoteFactory.prototype.createResource = async function (opts) {
    var s = this.settings;
    var today = window.moment().format(s.dateFormat || 'YYYY-MM-DD');
    var name = sanitizeBase(
      (opts.author ? opts.author + ' - ' : '') + opts.title,
      s.sanitizeFileNames
    );

    var inbox = obsidian.normalizePath(s.resource.inboxFolder);
    await this.ensureFolder(inbox);
    var newPath = obsidian.normalizePath(inbox + '/' + name + '.md');

    var existing = this.app.vault.getAbstractFileByPath(newPath);
    if (existing && !(opts.useActive && opts.activeFile && existing.path === opts.activeFile.path)) {
      new obsidian.Notice('Already exists: ' + newPath);
      return;
    }

    var projectFile = opts.projectPath ? this.app.vault.getAbstractFileByPath(opts.projectPath) : null;
    var indexFile = opts.indexPath ? this.app.vault.getAbstractFileByPath(opts.indexPath) : null;
    var projectBase = projectFile ? projectFile.basename : '';
    var indexBase = indexFile ? indexFile.basename : '';

    /* Source content: active note to transform, or resource template. */
    var raw = null;
    if (opts.useActive && opts.activeFile) {
      raw = await this.app.vault.read(opts.activeFile);
    } else if (s.resource.template) {
      raw = await this.loadTemplate(s.resource.template);
    }

    var split = splitTemplate(raw || '');
    var body = split.body || '';

    var tags = buildResourceTags(s.resource, indexBase, name + '\n' + body);
    var fm = resourceFrontmatter({
      author: opts.author,
      url: opts.url,
      today: today,
      projectBase: projectBase,
      task: opts.task,
      indexBase: indexBase,
      trustLevel: opts.trustLevel,
      tags: tags
    });

    var out = ['---'].concat(fm);
    split.keys.forEach(function (block, key) {
      if (RESOURCE_KEYS.indexOf(key) === -1) out.push(block);
    });
    out.push('---');
    out.push('');

    if (!/^#\s/m.test(body)) body = '# ' + name + '\n\n' + body;
    var content = out.join('\n') + body;

    var file;
    try {
      if (opts.useActive && opts.activeFile) {
        await this.app.vault.modify(opts.activeFile, content);
        if (opts.activeFile.path !== newPath) {
          await this.app.fileManager.renameFile(opts.activeFile, newPath);
        }
        file = opts.activeFile;
      } else {
        file = await this.app.vault.create(newPath, content);
      }
    } catch (e) {
      new obsidian.Notice('Creation failed: ' + newPath + ' — ' + e.message);
      return;
    }

    /* Backlinks: project (Ressources > LLM) and knowledge-index (LLM). */
    var projectChain = splitChain(s.resource.projectChain, ['Ressources', 'LLM']);
    var indexChain = splitChain(s.resource.indexChain, ['LLM']);
    if (projectFile) await this.insertResourceLink(projectFile, name, opts.author, projectChain);
    if (indexFile) await this.insertResourceLink(indexFile, name, opts.author, indexChain);

    new obsidian.Notice('Resource note created: ' + name);
    await this.app.workspace.getLeaf(false).openFile(file);
  };

  KnowledgeNoteFactory.prototype.createProject = async function (opts) {
    var s = this.settings;
    var id = window.moment().format(s.idFormat || 'YYYYMMDDHHmm');
    var today = window.moment().format(s.dateFormat || 'YYYY-MM-DD');
    var base = sanitizeBase(id + ' - ' + decorate('project', opts.title), s.sanitizeFileNames);

    var folder = obsidian.normalizePath(s.resource.projectFolder);
    await this.ensureFolder(folder);
    var path = obsidian.normalizePath(folder + '/' + base + '.md');
    if (this.app.vault.getAbstractFileByPath(path)) {
      new obsidian.Notice('Already exists: ' + path);
      return;
    }

    var tpl = s.project.template ? await this.loadTemplate(s.project.template) : null;
    var split = splitTemplate(tpl || '');

    var out = ['---'].concat(projectNoteFrontmatter({
      today: today,
      name: opts.shortName,
      parent: opts.parent,
      status: opts.status,
      type: opts.type
    }));
    split.keys.forEach(function (block, key) {
      if (PROJECT_KEYS.indexOf(key) === -1) out.push(block);
    });
    out.push('---');
    out.push('');

    var body = replacePlaceholders(split.body || '', {
      id: id, today: today, name: opts.title, base: base, indexBase: base
    });
    if (!body.trim()) body = PROJECT_BODY_SKELETON;
    if (!/^#\s/m.test(body)) body = '# ' + base + '\n\n' + body;

    var file;
    try {
      file = await this.app.vault.create(path, out.join('\n') + body);
    } catch (e) {
      new obsidian.Notice('Creation failed: ' + path + ' — ' + e.message);
      return;
    }
    new obsidian.Notice('Project note created: ' + base);
    await this.app.workspace.getLeaf(false).openFile(file);
  };

  KnowledgeNoteFactory.prototype.createTask = async function (opts) {
    var s = this.settings;
    var today = window.moment().format(s.dateFormat || 'YYYY-MM-DD');

    var projectFile = opts.projectPath ? this.app.vault.getAbstractFileByPath(opts.projectPath) : null;

    /* Task id: derived from the project id (…h -> …h1, …5 -> …5a), falling
     * back to a timestamp when no project is selected. */
    var id;
    var parentId = projectFile ? idFromBase(projectFile.basename) : '';
    if (parentId) id = this.nextChildId(parentId);
    else id = window.moment().format(s.idFormat || 'YYYYMMDDHHmm');

    var base = sanitizeBase(id + ' - ' + opts.title, s.sanitizeFileNames);

    var folder = obsidian.normalizePath(s.task.folder);
    await this.ensureFolder(folder);
    var path = obsidian.normalizePath(folder + '/' + base + '.md');
    if (this.app.vault.getAbstractFileByPath(path)) {
      new obsidian.Notice('Already exists: ' + path);
      return;
    }

    /* Short project name: frontmatter project.name of the selected project
     * note (via the metadata cache), falling back to its undecorated title. */
    var shortName = '';
    if (projectFile) {
      var cache = this.app.metadataCache.getFileCache(projectFile);
      var fm = cache && cache.frontmatter;
      if (fm && fm.project && fm.project.name) shortName = String(fm.project.name);
      if (!shortName) shortName = subjectFromBase(projectFile.basename);
    }

    var tpl = s.task.template ? await this.loadTemplate(s.task.template) : null;
    var split = splitTemplate(tpl || '');

    var out = ['---'].concat(taskNoteFrontmatter({
      today: today,
      project: shortName,
      status: opts.status,
      type: opts.type
    }));
    split.keys.forEach(function (block, key) {
      if (TASK_KEYS.indexOf(key) === -1) out.push(block);
    });
    out.push('---');
    out.push('');

    var body = replacePlaceholders(split.body || '', {
      id: id, today: today, name: opts.title, base: base,
      indexBase: projectFile ? projectFile.basename : base
    });
    if (!/^#\s/m.test(body)) body = '# ' + base + '\n\n' + body;

    var file;
    try {
      file = await this.app.vault.create(path, out.join('\n') + body);
    } catch (e) {
      new obsidian.Notice('Creation failed: ' + path + ' — ' + e.message);
      return;
    }

    /* Backlink: task listed in the project note under its task section. */
    if (projectFile) {
      await this.insertResourceLink(
        projectFile, base, null,
        splitChain(s.project.taskSection, ['Liste des tâches'])
      );
    }

    new obsidian.Notice('Task note created: ' + base);
    await this.app.workspace.getLeaf(false).openFile(file);
  };

  return KnowledgeNoteFactory;
})(obsidian.Plugin);

module.exports = KnowledgeNoteFactory;
