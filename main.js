'use strict';

/*
 * Knowledge Note Factory — plugin Obsidian
 * Crée en une commande un jeu de notes liées (Index, Flashcard, CheatSheet,
 * Gist, Slides, Groom) dans l'arborescence 5_Knowledges, à partir des
 * templates du dossier Ressources/Templates (chemins et noms configurables
 * dans les réglages du plugin).
 *
 * Écrit en JavaScript pur : aucun build nécessaire, déposer main.js +
 * manifest.json dans .obsidian/plugins/knowledge-note-factory/
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

/* Décoration du nom de fichier selon le type de note. */
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

/* Remplacement optionnel des caractères interdits sous Windows / gênants
 * pour la synchronisation ( * " \ / : < > | ? ). Les équivalents
 * pleine-chasse (＊ ＂) préservent l'apparence du schéma de nommage. */
function sanitizeBase(base, enabled) {
  if (!enabled) return base;
  return base
    .replace(/\*/g, '＊')
    .replace(/"/g, '＂')
    .replace(/[\\/:<>|?]/g, '-');
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
/* Analyse et fusion des templates                                     */
/* ------------------------------------------------------------------ */

/* Découpe un template en (clés de frontmatter -> bloc brut, corps). */
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

/* Frontmatter imposé par le cahier des charges, par type de note. */
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

/* Jetons de substitution utilisables dans le corps des templates. */
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

/* Construit le contenu final d'une note : frontmatter imposé + clés
 * supplémentaires éventuelles du template + corps du template enrichi. */
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
/* Modale de création                                                  */
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
    contentEl.createEl('h2', { text: 'Nouvelle note de connaissance' });

    new obsidian.Setting(contentEl)
      .setName('Sujet')
      .setDesc('Nom inséré dans les titres, ex. « AI »')
      .addText(function (t) {
        t.setPlaceholder('AI');
        t.onChange(function (v) { self.name = v; });
        t.inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') self.submit();
        });
        window.setTimeout(function () { t.inputEl.focus(); }, 10);
      });

    contentEl.createEl('h3', { text: 'Projet (note index)' });

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

    contentEl.createEl('h3', { text: 'Notes à créer' });
    TYPES.forEach(function (type) {
      new obsidian.Setting(contentEl)
        .setName(LABELS[type])
        .addToggle(function (tg) {
          tg.setValue(self.types[type]);
          tg.onChange(function (v) { self.types[type] = v; });
        });
    });

    new obsidian.Setting(contentEl).addButton(function (b) {
      b.setButtonText('Créer').setCta().onClick(function () { self.submit(); });
    });
  };

  CreateKnowledgeModal.prototype.submit = function () {
    if (!this.name || !this.name.trim()) {
      new obsidian.Notice('Indique un sujet.');
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
/* Onglet de réglages                                                  */
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
      .setName('Dossier des templates')
      .setDesc('Chemin du dossier contenant les fichiers de template')
      .addText(function (t) {
        t.setValue(self.plugin.settings.templateFolder);
        t.onChange(function (v) {
          self.plugin.settings.templateFolder = v.trim();
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Format de l’identifiant')
      .setDesc('Format moment.js — défaut : YYYYMMDDHHmm (ex. 202605122044)')
      .addText(function (t) {
        t.setValue(self.plugin.settings.idFormat);
        t.onChange(function (v) {
          self.plugin.settings.idFormat = v.trim() || 'YYYYMMDDHHmm';
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Format de la date « rédaction »')
      .setDesc('Format moment.js — défaut : YYYY-MM-DD')
      .addText(function (t) {
        t.setValue(self.plugin.settings.dateFormat);
        t.onChange(function (v) {
          self.plugin.settings.dateFormat = v.trim() || 'YYYY-MM-DD';
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Ouvrir la note index après création')
      .addToggle(function (tg) {
        tg.setValue(self.plugin.settings.openIndexAfterCreate);
        tg.onChange(function (v) {
          self.plugin.settings.openIndexAfterCreate = v;
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Assainir les noms de fichier (compatibilité Windows)')
      .setDesc('Remplace * et " par leurs équivalents pleine-chasse ＊ ＂ dans les noms de fichier. À activer si le coffre est synchronisé avec un poste Windows.')
      .addToggle(function (tg) {
        tg.setValue(self.plugin.settings.sanitizeFileNames);
        tg.onChange(function (v) {
          self.plugin.settings.sanitizeFileNames = v;
          self.plugin.saveSettings();
        });
      });

    containerEl.createEl('h3', { text: 'Valeurs par défaut du bloc project (index)' });

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

    containerEl.createEl('h3', { text: 'Types de notes' });

    TYPES.forEach(function (type) {
      containerEl.createEl('h4', { text: LABELS[type] });

      new obsidian.Setting(containerEl)
        .setName('Activé par défaut')
        .addToggle(function (tg) {
          tg.setValue(self.plugin.settings.types[type].enabled);
          tg.onChange(function (v) {
            self.plugin.settings.types[type].enabled = v;
            self.plugin.saveSettings();
          });
        });

      new obsidian.Setting(containerEl)
        .setName('Dossier de destination')
        .addText(function (t) {
          t.setValue(self.plugin.settings.types[type].folder);
          t.onChange(function (v) {
            self.plugin.settings.types[type].folder = v.trim();
            self.plugin.saveSettings();
          });
        });

      new obsidian.Setting(containerEl)
        .setName('Template')
        .setDesc('Nom du fichier dans le dossier des templates (avec ou sans .md)')
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
      name: 'Créer un jeu de notes de connaissance',
      callback: function () {
        new CreateKnowledgeModal(self.app, self).open();
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
        try { await this.app.vault.createFolder(cur); } catch (e) { /* déjà créé en parallèle */ }
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
    new obsidian.Notice('Template introuvable : ' + full + ' — frontmatter minimal utilisé.');
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
        new obsidian.Notice('Existe déjà, ignoré : ' + path);
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
          'Échec de création : ' + path + ' — ' + e.message +
          ' (si le message concerne les caractères * ou ", active « Assainir les noms de fichier » dans les réglages)'
        );
      }
    }

    new obsidian.Notice(createdCount + ' note(s) créée(s) — id ' + id);

    if (indexFile && s.openIndexAfterCreate) {
      await this.app.workspace.getLeaf(false).openFile(indexFile);
    }
  };

  return KnowledgeNoteFactory;
})(obsidian.Plugin);

module.exports = KnowledgeNoteFactory;
