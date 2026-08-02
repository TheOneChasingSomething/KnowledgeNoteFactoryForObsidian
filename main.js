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

/* POSIX single-quote escaping: wraps in '...' and encodes embedded quotes. */
function shellQuote(arg) {
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

/* Expands a leading ~ to the user's home directory (Node has no shell here). */
function expandHome(p) {
  if (!p) return p;
  var home = (typeof process !== 'undefined' && process.env &&
    (process.env.HOME || process.env.USERPROFILE)) || '';
  if (p === '~') return home || p;
  if (p.indexOf('~/') === 0 && home) return home + p.slice(1);
  return p;
}

/* Terminal emulator presets: bin + the flags that precede the command. */
var TERMINAL_PRESETS = {
  'gnome-terminal':     { bin: 'gnome-terminal',     args: ['--'] },
  'konsole':            { bin: 'konsole',            args: ['-e'] },
  'xfce4-terminal':     { bin: 'xfce4-terminal',     args: ['-x'] },
  'xterm':              { bin: 'xterm',              args: ['-e'] },
  'kitty':              { bin: 'kitty',              args: [] },
  'alacritty':          { bin: 'alacritty',          args: ['-e'] },
  'x-terminal-emulator':{ bin: 'x-terminal-emulator',args: ['-e'] }
};

/* Resolves the terminal bin + preceding args from settings (preset or custom). */
function resolveTerminal(video) {
  if (video.terminalPreset === 'custom') {
    return {
      bin: video.terminalBin || 'xterm',
      args: (video.terminalArgs || '').split(/\s+/).filter(Boolean)
    };
  }
  return TERMINAL_PRESETS[video.terminalPreset] || TERMINAL_PRESETS['xterm'];
}

/* Builds the inner shell line: base command, then either a raw argument
 * string (expert, unquoted) or a list of safely quoted arguments, plus an
 * optional "exec <shell>" so the window stays open after the command ends. */
function buildInnerCommand(video, opts) {
  opts = opts || {};
  var base = opts.baseOverride || video.baseCommand || '';
  var inner = '';
  /* Google OAuth2: expose the client secrets to the script via YT_DL_SECRETS
   * (the env-variable path from the script's own "No client secrets" hint). */
  if (video.secretsFile && video.secretsFile.trim()) {
    inner += 'export YT_DL_SECRETS=' + shellQuote(expandHome(video.secretsFile.trim())) + '; ';
  }
  inner += base;
  if (opts.rawArgs) {
    inner += ' ' + opts.rawArgs;
  } else if (opts.args && opts.args.length) {
    for (var i = 0; i < opts.args.length; i++) inner += ' ' + shellQuote(opts.args[i]);
  }
  if (video.keepOpen) inner += '; exec ' + (video.shell || 'bash');
  return inner;
}

/* Full spawn descriptor: { bin, args, cwd } for child_process.spawn. */
function buildSpawnPlan(video, opts) {
  var term = resolveTerminal(video);
  var shell = video.shell || 'bash';
  var inner = buildInnerCommand(video, opts);
  return {
    bin: term.bin,
    args: term.args.concat([shell, '-lc', inner]),
    cwd: expandHome(video.workdir || '') || undefined
  };
}

/* Rough URL classification for the clipboard shortcut. */
function classifyUrl(url) {
  var u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  if (/(?:youtube\.com|youtu\.be)/i.test(u)) {
    if (/[?&]list=/.test(u) && !/[?&]v=/.test(u)) return { kind: 'playlist', url: u };
    return { kind: 'video', url: u };
  }
  return { kind: 'article', url: u };
}

/* Recursively collects every bookmark group whose title matches, ignoring
 * case and surrounding spaces — so "4 - InProgress" nested anywhere matches
 * a setting spelled "4 - inProgress". */
function collectBookmarkGroups(items, title, out) {
  if (!items) return out;
  var wanted = String(title || '').trim().toLowerCase();
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it && it.type === 'group') {
      if (String(it.title || '').trim().toLowerCase() === wanted) out.push(it);
      collectBookmarkGroups(it.items, title, out);
    }
  }
  return out;
}

/* "pending" -> "Pending" (first letter only; the rest is preserved). */
function capitalizeFirst(v) {
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/* Canonical type: case-insensitive match against the configured list, with
 * an -ing bridge ("researching" -> "Research"); unknown values just get
 * their first letter capitalized. */
function canonicalType(v, canons) {
  var low = v.toLowerCase();
  for (var i = 0; i < canons.length; i++) {
    var c = canons[i];
    var cl = c.toLowerCase();
    if (low === cl || low === cl + 'ing' || cl === low + 'ing') return c;
  }
  return capitalizeFirst(v);
}

/* "ressources=resources, …" -> { ressources: 'resources', … } (keys lowered). */
function parseTagMap(str) {
  var map = {};
  splitCsv(str).forEach(function (pair) {
    var i = pair.indexOf('=');
    if (i === -1) return;
    var from = pair.slice(0, i).trim().toLowerCase();
    var to = pair.slice(i + 1).trim();
    if (from && to) map[from] = to;
  });
  return map;
}

/* Computes (and, when apply=true, performs) frontmatter normalization:
 * statuses capitalized, types canonicalized, tags removed (removeSet), then
 * mapped to their English form and case-insensitively deduplicated. Returns
 * change descriptions. removeSet is an optional map of lowercased tags to drop. */
function normalizeFrontmatter(fm, canons, tagMap, apply, removeSet) {
  removeSet = removeSet || {};
  var changes = [];

  function fixStatus(obj, key, label) {
    if (!obj || typeof obj[key] !== 'string' || !obj[key].trim()) return;
    var v = obj[key];
    var n = capitalizeFirst(v.trim());
    if (n !== v) {
      changes.push(label + ': "' + v + '" → "' + n + '"');
      if (apply) obj[key] = n;
    }
  }

  function fixType(obj, key, label) {
    if (!obj || typeof obj[key] !== 'string' || !obj[key].trim()) return;
    var v = obj[key];
    var n = canonicalType(v.trim(), canons);
    if (n !== v) {
      changes.push(label + ': "' + v + '" → "' + n + '"');
      if (apply) obj[key] = n;
    }
  }

  fixStatus(fm, 'status', 'status');
  fixStatus(fm.project, 'status', 'project.status');
  fixStatus(fm.task, 'status', 'task.status');
  fixType(fm, 'type', 'type');
  fixType(fm.project, 'type', 'project.type');
  fixType(fm.task, 'type', 'task.type');

  ['tags', 'Tags'].forEach(function (k) {
    var arr = fm[k];
    if (typeof arr === 'string' && arr.trim()) arr = [arr];
    if (!Array.isArray(arr)) return;
    var out = [];
    var seen = {};
    var changed = false;
    for (var i = 0; i < arr.length; i++) {
      var tag = arr[i];
      if (typeof tag !== 'string') { out.push(tag); continue; }
      var trimmed = tag.trim();
      var mapped = tagMap[trimmed.toLowerCase()] || trimmed;
      var keyL = mapped.toLowerCase();
      if (removeSet[keyL] || removeSet[trimmed.toLowerCase()]) {
        changed = true;
        changes.push(k + ': "' + tag + '" removed');
        continue;
      }
      if (seen[keyL]) {
        changed = true;
        changes.push(k + ': duplicate "' + tag + '" removed');
        continue;
      }
      seen[keyL] = true;
      if (mapped !== tag) {
        changed = true;
        changes.push(k + ': "' + tag + '" → "' + mapped + '"');
      }
      out.push(mapped);
    }
    if (changed && apply) fm[k] = out;
  });

  return changes;
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
var TPL_RESOURCE_STARTER = '---\nAuthor: \nURL: \nPublication: {{date}}\nLecture: {{date}}\nProject: \nTask: \nKnowledge-index: \nTrustLevel: \ndownload:\nTags:\n  - literature-note\n  - resource-note\n---\n';
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
    fixedTags: 'literature-note, resource-note'
  },
  project: {
    template: '',
    taskSection: 'Liste des tâches',
    pendingGroup: '4 - InProgress',
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
  normalize: {
    types: 'Coding, VibeCoding, Challenge, Research, Knowledge, Config, Tooling',
    tagMap: 'ressource=resource, ressources=resources, ressource-note=resource-note, ressources-note=resources-note',
    tagRemove: 'resource, resources-note'
  },
  video: {
    workdir: '',
    baseCommand: 'source venv/bin/activate && python3 main.py',
    secretsFile: '',
    installCommand: 'python3 -m venv venv 2>/dev/null; source venv/bin/activate && (python3 -c "import yt_dlp, keyring, typer" 2>/dev/null && echo "Dependencies already installed." || (echo "Installing dependencies…" && pip install -e .))',
    secretsSetupCommand: 'source venv/bin/activate && python3 -c "import keyring,glob,os; f=glob.glob(\'client_secrets*.json\'); (keyring.set_password(\'yt_playlist_dl\',\'client_secrets\',open(f[0]).read()) or print(\'Stored in keyring:\',f[0])) if f else print(\'client_secrets*.json introuvable dans\',os.getcwd())"',
    shell: 'bash',
    terminalPreset: 'gnome-terminal',
    terminalBin: '',
    terminalArgs: '',
    keepOpen: true,
    passVault: true,
    flagProject: '--project',
    flagIndex: '--knowledge-index',
    flagVault: '--vault'
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

    /* Prefill with the active note when it looks like a project or task. */
    var active = app.workspace.getActiveFile();
    if (active && active.extension === 'md') {
      var pFolder = obsidian.normalizePath(plugin.settings.resource.projectFolder || '');
      var tFolder = obsidian.normalizePath(plugin.settings.task.folder || '');
      var cache = app.metadataCache.getFileCache(active);
      var fm = cache && cache.frontmatter;
      var looksRight = (pFolder && active.path.indexOf(pFolder + '/') === 0) ||
        (tFolder && active.path.indexOf(tFolder + '/') === 0) ||
        (fm && (fm.project || fm.task));
      if (looksRight) _this.projectText = active.basename;
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
    contentEl.createEl('h2', { text: 'Project / task status' });

    new obsidian.Setting(contentEl)
      .setName('Note')
      .setDesc('Project or task note — type its name or [[…]], suggestions as in Obsidian')
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
    this.plugin.setNoteStatus(file, this.status);
  };

  ProjectStatusModal.prototype.onClose = function () {
    this.contentEl.empty();
  };

  return ProjectStatusModal;
})(obsidian.Modal);

/* ------------------------------------------------------------------ */
/* Frontmatter check & normalize modal                                 */
/* ------------------------------------------------------------------ */

var NormalizeModal = /** @class */ (function (_super) {
  function NormalizeModal(app, plugin) {
    var _this = _super.call(this, app) || this;
    _this.plugin = plugin;
    _this.running = false;
    return _this;
  }
  if (Object.setPrototypeOf) Object.setPrototypeOf(NormalizeModal, _super);
  NormalizeModal.prototype = Object.create(_super.prototype);
  NormalizeModal.prototype.constructor = NormalizeModal;

  NormalizeModal.prototype.onOpen = function () {
    var self = this;
    var contentEl = this.contentEl;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Check & normalize frontmatter' });
    contentEl.createEl('p', {
      text: 'Scans every note of the vault: capitalizes status values ' +
        '(pending → Pending), canonicalizes types (' +
        this.plugin.settings.normalize.types + '), maps tags to English ' +
        'and removes duplicates. "Check" only reports; "Normalize" writes.'
    });

    new obsidian.Setting(contentEl)
      .addButton(function (b) {
        b.setButtonText('Check').onClick(function () { self.run(false); });
      })
      .addButton(function (b) {
        b.setButtonText('Normalize').setCta().onClick(function () { self.run(true); });
      });

    this.resultsEl = contentEl.createEl('div');
  };

  NormalizeModal.prototype.run = async function (apply) {
    if (this.running) return;
    this.running = true;
    var self = this;
    this.resultsEl.empty();
    this.resultsEl.createEl('p', { text: 'Scanning…' });
    try {
      var results = await this.plugin.normalizeFrontmatters(apply);
      this.resultsEl.empty();
      var head;
      if (!results.length) head = 'All frontmatters are already normalized.';
      else if (apply) head = results.length + ' note(s) updated.';
      else head = results.length + ' note(s) need normalization.';
      this.resultsEl.createEl('p', { text: head });
      var max = 60;
      for (var i = 0; i < Math.min(results.length, max); i++) {
        var r = results[i];
        var d = self.resultsEl.createEl('div');
        d.createEl('strong', { text: r.file.basename });
        d.createEl('div', { text: r.changes.join(' ; ') });
      }
      if (results.length > max) {
        this.resultsEl.createEl('p', { text: '… and ' + (results.length - max) + ' more.' });
      }
      new obsidian.Notice(head);
    } catch (e) {
      this.resultsEl.empty();
      this.resultsEl.createEl('p', { text: 'Error: ' + e.message });
    }
    this.running = false;
  };

  NormalizeModal.prototype.onClose = function () {
    this.contentEl.empty();
  };

  return NormalizeModal;
})(obsidian.Modal);

/* ------------------------------------------------------------------ */
/* Video Notes Manager — guided download modal                         */
/* ------------------------------------------------------------------ */

var VideoDownloadModal = /** @class */ (function (_super) {
  function VideoDownloadModal(app, plugin) {
    var _this = _super.call(this, app) || this;
    _this.plugin = plugin;
    _this.url = '';
    _this.kind = 'auto';
    _this.projectText = '';
    _this.indexText = '';
    return _this;
  }
  if (Object.setPrototypeOf) Object.setPrototypeOf(VideoDownloadModal, _super);
  VideoDownloadModal.prototype = Object.create(_super.prototype);
  VideoDownloadModal.prototype.constructor = VideoDownloadModal;

  VideoDownloadModal.prototype.onOpen = async function () {
    var self = this;
    var contentEl = this.contentEl;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Download — guided' });

    /* Prefill URL from clipboard when it is a URL. */
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.readText) {
        var clip = await navigator.clipboard.readText();
        if (/^https?:\/\//i.test((clip || '').trim())) self.url = clip.trim();
      }
    } catch (e) { /* clipboard blocked */ }

    new obsidian.Setting(contentEl)
      .setName('URL')
      .addText(function (t) {
        t.setValue(self.url);
        t.setPlaceholder('https://…');
        t.onChange(function (v) { self.url = v.trim(); });
        t.inputEl.style.width = '100%';
        window.setTimeout(function () { t.inputEl.focus(); }, 10);
      });

    new obsidian.Setting(contentEl)
      .setName('Type')
      .addDropdown(function (d) {
        d.addOption('auto', 'Auto (YouTube → video, else article)');
        d.addOption('video', 'video');
        d.addOption('article', 'article');
        d.setValue(self.kind);
        d.onChange(function (v) { self.kind = v; });
      });

    new obsidian.Setting(contentEl)
      .setName('Project')
      .setDesc('Passed to the script as ' + self.plugin.settings.video.flagProject + ' — type [[…]]')
      .addText(function (t) {
        t.setPlaceholder('[[project note]]');
        t.onChange(function (v) { self.projectText = v; });
        attachFileSuggest(self.app, t.inputEl, self.plugin.settings.resource.projectFolder, function (file) {
          self.projectText = file.basename;
        });
      });

    new obsidian.Setting(contentEl)
      .setName('Knowledge-index')
      .setDesc('Passed to the script as ' + self.plugin.settings.video.flagIndex + ' — type [[…]]')
      .addText(function (t) {
        t.setPlaceholder('[[index note]]');
        t.onChange(function (v) { self.indexText = v; });
        attachFileSuggest(self.app, t.inputEl, self.plugin.settings.types.index.folder, function (file) {
          self.indexText = file.basename;
        });
      });

    new obsidian.Setting(contentEl).addButton(function (b) {
      b.setButtonText('Download in terminal').setCta().onClick(function () { self.submit(); });
    });
  };

  VideoDownloadModal.prototype.submit = function () {
    var v = this.plugin.settings.video;
    if (!this.url) { new obsidian.Notice('Enter a URL.'); return; }

    var kind = this.kind;
    if (kind === 'auto') {
      var c = classifyUrl(this.url);
      kind = (c && c.kind === 'article') ? 'article' : 'video';
    }

    var args = ['download', kind, this.url];

    var proj = this.plugin.resolveNote(this.projectText);
    if (this.projectText && this.projectText.trim() && !proj) {
      new obsidian.Notice('Project note not found: ' + this.projectText);
    }
    if (proj && v.flagProject) args.push(v.flagProject, proj.basename);

    var idx = this.plugin.resolveNote(this.indexText);
    if (this.indexText && this.indexText.trim() && !idx) {
      new obsidian.Notice('Index note not found: ' + this.indexText);
    }
    if (idx && v.flagIndex) args.push(v.flagIndex, idx.basename);

    if (v.passVault && v.flagVault) {
      var base = this.plugin.vaultBasePath();
      if (base) args.push(v.flagVault, base);
    }

    this.close();
    this.plugin.runVideoManager({ args: args });
  };

  VideoDownloadModal.prototype.onClose = function () {
    this.contentEl.empty();
  };

  return VideoDownloadModal;
})(obsidian.Modal);

/* ------------------------------------------------------------------ */
/* Video Notes Manager — argument modal                                */
/* ------------------------------------------------------------------ */

var VideoRunModal = /** @class */ (function (_super) {
  function VideoRunModal(app, plugin) {
    var _this = _super.call(this, app) || this;
    _this.plugin = plugin;
    _this.args = '';
    return _this;
  }
  if (Object.setPrototypeOf) Object.setPrototypeOf(VideoRunModal, _super);
  VideoRunModal.prototype = Object.create(_super.prototype);
  VideoRunModal.prototype.constructor = VideoRunModal;

  VideoRunModal.prototype.onOpen = function () {
    var self = this;
    var contentEl = this.contentEl;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Video Notes Manager — run' });
    contentEl.createEl('p', {
      text: 'Arguments appended to "' + this.plugin.settings.video.baseCommand +
        '". Example: download video "https://youtu.be/xxx"'
    });

    new obsidian.Setting(contentEl)
      .setName('Arguments')
      .addText(function (t) {
        t.setPlaceholder('download video "URL"');
        t.onChange(function (v) { self.args = v; });
        t.inputEl.style.width = '100%';
        t.inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') self.submit();
        });
        window.setTimeout(function () { t.inputEl.focus(); }, 10);
      });

    new obsidian.Setting(contentEl).addButton(function (b) {
      b.setButtonText('Run in terminal').setCta().onClick(function () { self.submit(); });
    });
  };

  VideoRunModal.prototype.submit = function () {
    this.close();
    this.plugin.runVideoManager({ rawArgs: this.args });
  };

  VideoRunModal.prototype.onClose = function () {
    this.contentEl.empty();
  };

  return VideoRunModal;
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

    containerEl.createEl('h3', { text: 'Normalization' });

    new obsidian.Setting(containerEl)
      .setName('Canonical types')
      .setDesc('Comma-separated list; values are matched case-insensitively, with an -ing bridge (researching → Research)')
      .addText(function (t) {
        t.setValue(self.plugin.settings.normalize.types);
        t.onChange(function (v) {
          self.plugin.settings.normalize.types = v;
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Tag map')
      .setDesc('from=to pairs, comma-separated — English is preferred (ressources=resources)')
      .addText(function (t) {
        t.setValue(self.plugin.settings.normalize.tagMap);
        t.onChange(function (v) {
          self.plugin.settings.normalize.tagMap = v;
          self.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('Tags to remove')
      .setDesc('Comma-separated tags stripped from every note by Normalize (case-insensitive)')
      .addText(function (t) {
        t.setValue(self.plugin.settings.normalize.tagRemove);
        t.onChange(function (v) {
          self.plugin.settings.normalize.tagRemove = v;
          self.plugin.saveSettings();
        });
      });

    containerEl.createEl('h3', { text: 'Video Notes Manager' });

    new obsidian.Setting(containerEl)
      .setName('Project folder')
      .setDesc('Absolute path to the ObsidianVideoNotesManager repository (used as working directory)')
      .addText(function (t) {
        t.setValue(self.plugin.settings.video.workdir);
        t.setPlaceholder('~/git/ObsidianVideoNotesManager');
        t.onChange(function (v) { self.plugin.settings.video.workdir = v.trim(); self.plugin.saveSettings(); });
      });

    new obsidian.Setting(containerEl)
      .setName('Base command')
      .setDesc('Shell command run inside the project folder; arguments are appended to it')
      .addText(function (t) {
        t.setValue(self.plugin.settings.video.baseCommand);
        t.onChange(function (v) { self.plugin.settings.video.baseCommand = v; self.plugin.saveSettings(); });
      });

    new obsidian.Setting(containerEl)
      .setName('Google client secrets (YT_DL_SECRETS)')
      .setDesc('Path to client_secrets.json; exported as YT_DL_SECRETS before each run (leave empty if you use the keyring)')
      .addText(function (t) {
        t.setValue(self.plugin.settings.video.secretsFile);
        t.setPlaceholder('~/…/client_secrets.json');
        t.onChange(function (v) { self.plugin.settings.video.secretsFile = v.trim(); self.plugin.saveSettings(); });
      });

    new obsidian.Setting(containerEl)
      .setName('Credentials setup command')
      .setDesc('Command run by "store Google credentials (keyring)" — stores client_secrets.json into the system keyring')
      .addText(function (t) {
        t.setValue(self.plugin.settings.video.secretsSetupCommand);
        t.onChange(function (v) { self.plugin.settings.video.secretsSetupCommand = v; self.plugin.saveSettings(); });
      });

    new obsidian.Setting(containerEl)
      .setName('Install / check command')
      .setDesc('Command run by "install / check dependencies" — creates the venv if needed and runs pip install -e . only when the libraries are missing')
      .addText(function (t) {
        t.setValue(self.plugin.settings.video.installCommand);
        t.onChange(function (v) { self.plugin.settings.video.installCommand = v; self.plugin.saveSettings(); });
      });

    new obsidian.Setting(containerEl)
      .setName('Shell')
      .setDesc('Shell used to run the command (bash, zsh, sh…)')
      .addText(function (t) {
        t.setValue(self.plugin.settings.video.shell);
        t.onChange(function (v) { self.plugin.settings.video.shell = v.trim() || 'bash'; self.plugin.saveSettings(); });
      });

    new obsidian.Setting(containerEl)
      .setName('Terminal')
      .setDesc('Terminal emulator that hosts the TUI')
      .addDropdown(function (d) {
        ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm', 'kitty', 'alacritty', 'x-terminal-emulator', 'custom']
          .forEach(function (k) { d.addOption(k, k); });
        d.setValue(self.plugin.settings.video.terminalPreset);
        d.onChange(function (v) { self.plugin.settings.video.terminalPreset = v; self.plugin.saveSettings(); self.display(); });
      });

    if (self.plugin.settings.video.terminalPreset === 'custom') {
      new obsidian.Setting(containerEl)
        .setName('Custom terminal binary')
        .addText(function (t) {
          t.setValue(self.plugin.settings.video.terminalBin);
          t.setPlaceholder('wezterm');
          t.onChange(function (v) { self.plugin.settings.video.terminalBin = v.trim(); self.plugin.saveSettings(); });
        });
      new obsidian.Setting(containerEl)
        .setName('Custom terminal args')
        .setDesc('Flags before the command, space-separated (e.g. "start --")')
        .addText(function (t) {
          t.setValue(self.plugin.settings.video.terminalArgs);
          t.onChange(function (v) { self.plugin.settings.video.terminalArgs = v; self.plugin.saveSettings(); });
        });
    }

    new obsidian.Setting(containerEl)
      .setName('Keep terminal open')
      .setDesc('Append "exec <shell>" so the window stays open after the command ends')
      .addToggle(function (tg) {
        tg.setValue(self.plugin.settings.video.keepOpen);
        tg.onChange(function (v) { self.plugin.settings.video.keepOpen = v; self.plugin.saveSettings(); });
      });

    new obsidian.Setting(containerEl)
      .setName('Pass vault path')
      .setDesc('Append the vault flag with Obsidian\'s absolute vault path to guided downloads')
      .addToggle(function (tg) {
        tg.setValue(self.plugin.settings.video.passVault);
        tg.onChange(function (v) { self.plugin.settings.video.passVault = v; self.plugin.saveSettings(); });
      });

    [['flagProject', 'Project flag'], ['flagIndex', 'Knowledge-index flag'], ['flagVault', 'Vault flag']].forEach(function (f) {
      new obsidian.Setting(containerEl)
        .setName(f[1])
        .setDesc('CLI flag name your script expects (guided download); leave empty to omit')
        .addText(function (t) {
          t.setValue(self.plugin.settings.video[f[0]]);
          t.onChange(function (v) { self.plugin.settings.video[f[0]] = v.trim(); self.plugin.saveSettings(); });
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
      name: 'Set status — project or task (Pending / Pause)',
      callback: function () {
        new ProjectStatusModal(self.app, self).open();
      }
    });

    this.addCommand({
      id: 'set-active-pending',
      name: 'Set current note to Pending',
      checkCallback: function (checking) {
        var f = self.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md') return false;
        if (!checking) self.setNoteStatus(f, 'Pending');
        return true;
      }
    });

    this.addCommand({
      id: 'set-active-pause',
      name: 'Set current note to Pause',
      checkCallback: function (checking) {
        var f = self.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md') return false;
        if (!checking) self.setNoteStatus(f, 'Pause');
        return true;
      }
    });

    this.addCommand({
      id: 'init-structure',
      name: 'Initialize structure (folders, templates, bookmarks)',
      callback: function () {
        self.initializeStructure();
      }
    });

    this.addCommand({
      id: 'check-normalize-frontmatter',
      name: 'Check & normalize frontmatter',
      callback: function () {
        new NormalizeModal(self.app, self).open();
      }
    });

    this.addCommand({
      id: 'video-open-tui',
      name: 'Video Notes Manager: open interactive menu (TUI)',
      checkCallback: function (checking) {
        if (obsidian.Platform && !obsidian.Platform.isDesktopApp) return false;
        if (!checking) self.runVideoManager({});
        return true;
      }
    });

    this.addCommand({
      id: 'video-run-args',
      name: 'Video Notes Manager: run with arguments…',
      checkCallback: function (checking) {
        if (obsidian.Platform && !obsidian.Platform.isDesktopApp) return false;
        if (!checking) new VideoRunModal(self.app, self).open();
        return true;
      }
    });

    this.addCommand({
      id: 'video-download-guided',
      name: 'Video Notes Manager: download (guided — project & index)',
      checkCallback: function (checking) {
        if (obsidian.Platform && !obsidian.Platform.isDesktopApp) return false;
        if (!checking) new VideoDownloadModal(self.app, self).open();
        return true;
      }
    });

    this.addCommand({
      id: 'video-download-clipboard',
      name: 'Video Notes Manager: download URL from clipboard',
      checkCallback: function (checking) {
        if (obsidian.Platform && !obsidian.Platform.isDesktopApp) return false;
        if (!checking) self.runVideoFromClipboard();
        return true;
      }
    });

    this.addCommand({
      id: 'video-store-credentials',
      name: 'Video Notes Manager: store Google credentials (keyring)',
      checkCallback: function (checking) {
        if (obsidian.Platform && !obsidian.Platform.isDesktopApp) return false;
        if (!checking) self.runVideoManager({ baseOverride: self.settings.video.secretsSetupCommand });
        return true;
      }
    });

    this.addCommand({
      id: 'video-revoke-credentials',
      name: 'Video Notes Manager: revoke Google credentials',
      checkCallback: function (checking) {
        if (obsidian.Platform && !obsidian.Platform.isDesktopApp) return false;
        if (!checking) self.runVideoManager({ args: ['revoke'] });
        return true;
      }
    });

    this.addCommand({
      id: 'video-install-deps',
      name: 'Video Notes Manager: install / check dependencies',
      checkCallback: function (checking) {
        if (obsidian.Platform && !obsidian.Platform.isDesktopApp) return false;
        if (!checking) self.runVideoManager({ baseOverride: self.settings.video.installCommand });
        return true;
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
    this.settings.normalize = Object.assign(
      {},
      DEFAULT_SETTINGS.normalize,
      stored.normalize || {}
    );
    this.settings.video = Object.assign(
      {},
      DEFAULT_SETTINGS.video,
      stored.video || {}
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

  /* Scans every markdown note's frontmatter; when apply=true the changes
   * are written through processFrontMatter. The metadata cache object is
   * never mutated: the probe pass runs with apply=false on it. */
  KnowledgeNoteFactory.prototype.normalizeFrontmatters = async function (apply) {
    var s = this.settings;
    var canons = splitCsv(s.normalize.types);
    var tagMap = parseTagMap(s.normalize.tagMap);
    var removeSet = {};
    splitCsv(s.normalize.tagRemove).forEach(function (t) { removeSet[t.toLowerCase()] = true; });
    var files = this.app.vault.getMarkdownFiles();
    var results = [];

    for (var i = 0; i < files.length; i++) {
      var cache = this.app.metadataCache.getFileCache(files[i]);
      var fm = cache && cache.frontmatter;
      if (!fm) continue;
      var probe = normalizeFrontmatter(fm, canons, tagMap, false, removeSet);
      if (!probe.length) continue;
      if (apply) {
        try {
          await this.app.fileManager.processFrontMatter(files[i], function (fmw) {
            normalizeFrontmatter(fmw, canons, tagMap, true, removeSet);
          });
        } catch (e) {
          probe.push('WRITE FAILED: ' + e.message);
        }
      }
      results.push({ file: files[i], changes: probe });
    }
    return results;
  };

  /* Absolute filesystem path of the vault (desktop FileSystemAdapter). */
  KnowledgeNoteFactory.prototype.vaultBasePath = function () {
    var a = this.app.vault.adapter;
    if (a && typeof a.getBasePath === 'function') return a.getBasePath();
    if (a && a.basePath) return a.basePath;
    return '';
  };

  /* Launches the Video Notes Manager script in an external terminal.
   * opts: {} (interactive TUI), { rawArgs } (expert string, unquoted) or
   * { args } (safely quoted list). Desktop only — uses Node child_process. */
  KnowledgeNoteFactory.prototype.runVideoManager = function (opts) {
    var v = this.settings.video;
    if (obsidian.Platform && !obsidian.Platform.isDesktopApp) {
      new obsidian.Notice('Video Notes Manager runs on desktop only.');
      return;
    }
    if (!v.workdir || !v.workdir.trim()) {
      new obsidian.Notice('Set the project folder in the plugin settings first.');
      return;
    }

    var child_process;
    try {
      child_process = require('child_process');
    } catch (e) {
      new obsidian.Notice('Cannot access child_process (desktop only).');
      return;
    }

    var plan = buildSpawnPlan(v, opts || {});
    try {
      var proc = child_process.spawn(plan.bin, plan.args, {
        cwd: plan.cwd,
        detached: true,
        stdio: 'ignore'
      });
      proc.on('error', function (err) {
        new obsidian.Notice('Launch failed (' + plan.bin + '): ' + err.message +
          ' — check the terminal setting.');
      });
      if (typeof proc.unref === 'function') proc.unref();
      new obsidian.Notice('Video Notes Manager launched in ' + plan.bin + '.');
    } catch (e) {
      new obsidian.Notice('Launch failed: ' + e.message);
    }
  };

  /* Reads the clipboard, classifies the URL and runs the matching command. */
  KnowledgeNoteFactory.prototype.runVideoFromClipboard = async function () {
    var text = '';
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch (e) { /* clipboard blocked */ }
    var c = classifyUrl(text);
    if (!c) {
      new obsidian.Notice('Clipboard does not contain a supported URL.');
      return;
    }
    this.runVideoManager({ args: ['download', c.kind, c.url] });
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

  /* Bookmark group by title — case-insensitive, searched recursively at any
   * depth; created at the root on demand when create=true and none matches. */
  KnowledgeNoteFactory.prototype.findBookmarkGroup = function (bk, title, create) {
    var items = bk.items || (bk.items = []);
    var matches = collectBookmarkGroups(items, title, []);
    if (matches.length) return matches[0];
    if (!create) return null;
    var group = { type: 'group', ctime: Date.now(), title: title, items: [] };
    items.push(group);
    return group;
  };

  /* Sets the status in the frontmatter — task.status for a task note,
   * project.status for a project note — and moves the note's bookmark into
   * the group matching the status (Pending -> pendingGroup,
   * Pause -> pauseGroup), removing it from the other group. */
  KnowledgeNoteFactory.prototype.setNoteStatus = async function (file, status) {
    var s = this.settings;

    /* Kind detection: a task block or a Task-Note tag makes it a task;
     * anything else is treated as a project. */
    var cache = this.app.metadataCache.getFileCache(file);
    var fm0 = cache && cache.frontmatter;
    var isTask = false;
    if (fm0) {
      if (fm0.task && typeof fm0.task === 'object') {
        isTask = true;
      } else {
        var tags0 = fm0.tags || fm0.Tags;
        if (typeof tags0 === 'string') tags0 = [tags0];
        if (Array.isArray(tags0)) {
          for (var ti = 0; ti < tags0.length; ti++) {
            if (String(tags0[ti]).trim().toLowerCase() === 'task-note') { isTask = true; break; }
          }
        }
      }
    }

    try {
      await this.app.fileManager.processFrontMatter(file, function (fm) {
        if (isTask) {
          if (!fm.task || typeof fm.task !== 'object') fm.task = {};
          fm.task.status = status;
          /* Repair pollution left by earlier versions: a project block that
           * only carries a status (or nothing) on a task note. */
          if (fm.project && typeof fm.project === 'object') {
            var keys = Object.keys(fm.project).filter(function (k) {
              var v = fm.project[k];
              return v !== null && v !== undefined && v !== '';
            });
            if (keys.length === 0 || (keys.length === 1 && keys[0] === 'status')) {
              delete fm.project;
            }
          }
        } else {
          if (!fm.project || typeof fm.project !== 'object') fm.project = {};
          fm.project.status = status;
        }
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

    var rootItems = bk.items || (bk.items = []);

    /* Remove from every group carrying the other status, wherever it sits. */
    var otherGroups = collectBookmarkGroups(rootItems, otherTitle, []);
    for (var og = 0; og < otherGroups.length; og++) {
      removeBookmarkPath(otherGroups[og], file.path);
    }

    /* One single bookmark in the first group carrying the target status:
     * clean every duplicate first, then add. */
    var target = this.findBookmarkGroup(bk, targetTitle, true);
    var targetGroups = collectBookmarkGroups(rootItems, targetTitle, []);
    for (var tg = 0; tg < targetGroups.length; tg++) {
      removeBookmarkPath(targetGroups[tg], file.path);
    }
    (target.items || (target.items = [])).push({ type: 'file', ctime: Date.now(), path: file.path });

    if (typeof bk.saveData === 'function') bk.saveData();
    if (typeof bk.trigger === 'function') bk.trigger('changed');

    new obsidian.Notice('"' + file.basename + '" → ' + status +
      ' (' + (isTask ? 'task' : 'project') + ', bookmarked in "' + targetTitle + '")');
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
