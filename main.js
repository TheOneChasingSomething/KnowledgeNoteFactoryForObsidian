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

function normalizeHeadingText(t) {
  return String(t).replace(/[*_`~]/g, '').trim().toLowerCase();
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

/* Inserts a bullet under a chain of headings (e.g. Ressources > LLM),
 * grouped after the last bullet by the same author. Creates missing headings. */
function insertIntoSection(content, bullet, chain, author) {
  var lines = content.split('\n');
  var start = 0;
  var end = lines.length;
  var level = 0;

  for (var c = 0; c < chain.length; c++) {
    var wanted = normalizeHeadingText(chain[c]);
    var found = -1;
    var foundLevel = 0;
    for (var i = start; i < end; i++) {
      var h = headingInfo(lines[i]);
      if (h && normalizeHeadingText(h.text) === wanted) { found = i; foundLevel = h.level; break; }
    }
    if (found === -1) {
      /* Missing headings: created at the end of the current scope. */
      var toInsert = [];
      var curLevel = level > 0 ? level + 1 : 2;
      if (end > 0 && lines[end - 1] && lines[end - 1].trim() !== '') toInsert.push('');
      for (var r = c; r < chain.length; r++) {
        toInsert.push(Array(Math.min(curLevel, 6) + 1).join('#') + ' ' + chain[r]);
        toInsert.push('');
        curLevel++;
      }
      toInsert.push(bullet);
      Array.prototype.splice.apply(lines, [end, 0].concat(toInsert));
      return lines.join('\n');
    }
    /* Narrow the scope to this heading's content. */
    start = found + 1;
    var scopeEnd = end;
    for (var j = start; j < end; j++) {
      var h2 = headingInfo(lines[j]);
      if (h2 && h2.level <= foundLevel) { scopeEnd = j; break; }
    }
    end = scopeEnd;
    level = foundLevel;
  }

  var lastBullet = -1;
  var lastAuthorBullet = -1;
  var authorRe = author ? new RegExp('\\b' + escapeRegExp(author) + '\\s*-', 'i') : null;
  for (var k = start; k < end; k++) {
    if (/^\s*[-*+]\s+\S/.test(lines[k])) {
      lastBullet = k;
      if (authorRe && authorRe.test(lines[k])) lastAuthorBullet = k;
    }
  }
  var pos;
  if (lastAuthorBullet !== -1) pos = lastAuthorBullet + 1;
  else if (lastBullet !== -1) pos = lastBullet + 1;
  else {
    pos = start;
    while (pos < end && lines[pos].trim() === '') pos++;
  }
  lines.splice(pos, 0, bullet);
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
    projectFolder: '1_Projects',
    template: '',
    trustLevel: '',
    authors: 'ChatGPT, Claude, ClaudeIA, Claude IA, Lumo',
    keywords: 'Git, GitHub, GitLab, TLS, HTTPS, SSH, MITM, CTF, Docker, Python, JavaScript, V8, Linux, Obsidian',
    fixedTags: 'literature-note, ressources-note, resource, resource-note'
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
    _this.projectPath = '';
    _this.indexPath = '';

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
      .setDesc('Project note where the link is inserted (Ressources > LLM)')
      .addDropdown(function (d) {
        d.addOption('', '— None —');
        self.plugin.listNotesIn(self.plugin.settings.resource.projectFolder).forEach(function (f) {
          d.addOption(f.path, f.basename);
        });
        d.onChange(function (v) { self.projectPath = v; });
      });

    new obsidian.Setting(contentEl)
      .setName('Knowledge-index')
      .setDesc('Index note where the link is inserted (LLM)')
      .addDropdown(function (d) {
        d.addOption('', '— None —');
        self.plugin.listNotesIn(self.plugin.settings.types.index.folder).forEach(function (f) {
          d.addOption(f.path, f.basename);
        });
        d.onChange(function (v) { self.indexPath = v; });
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
    var opts = {
      useActive: this.useActive,
      activeFile: this.useActive ? this.activeFile : null,
      author: this.author,
      title: this.title.trim(),
      url: this.url,
      task: this.task,
      trustLevel: this.trustLevel,
      projectPath: this.projectPath,
      indexPath: this.indexPath
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
      ['projectFolder', 'Projects folder', 'Folder scanned to list project notes in the modal'],
      ['template', 'Resource template', 'Template name in the template folder (empty: none)'],
      ['trustLevel', 'Default TrustLevel', 'Initial value of the TrustLevel field'],
      ['authors', 'Suggested authors', 'Comma-separated list, used for input assistance and link grouping'],
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
    if (projectFile) await this.insertResourceLink(projectFile, name, opts.author, ['Ressources', 'LLM']);
    if (indexFile) await this.insertResourceLink(indexFile, name, opts.author, ['LLM']);

    new obsidian.Notice('Resource note created: ' + name);
    await this.app.workspace.getLeaf(false).openFile(file);
  };

  return KnowledgeNoteFactory;
})(obsidian.Plugin);

module.exports = KnowledgeNoteFactory;
