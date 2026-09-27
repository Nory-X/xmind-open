'use strict';

/**
 * XMind Open — surface .xmind files in Obsidian's file explorer, preview them,
 * and hand them off to the OS default application (XMind) when clicked.
 *
 * Inputs : vault files whose extension is `xmind`.
 * Outputs: one registered view type. Nothing is ever written back. The only
 *          bytes read out of an archive are `Thumbnails/thumbnail.png` — the
 *          pre-rendered preview XMind itself stores for this purpose. The
 *          mindmap data (`content.json`) is never opened, so the plugin needs
 *          no knowledge of the XMind document format.
 * Depends: `obsidian` (FileView / Plugin / PluginSettingTab / setIcon),
 *          `zlib` (built-in; one deflate entry per archive),
 *          `fs` / `child_process` (only for the optional custom-path mode),
 *          `app.openWithDefaultApp` (internal — probed, not assumed),
 *          `electron.shell.openPath` (fallback only).
 *
 * How opening works: the plugin never hunts for XMind. It hands the *file* to
 * the OS (`openWithDefaultApp` / `shell.openPath`), and Windows resolves
 * `.xmind` through its own file association — so the plugin does not need to
 * know where XMind is installed. A path only becomes necessary when that
 * association is missing or has been hijacked by another program; then the
 * settings can name an executable and the plugin launches it directly.
 *
 * Why this shape: Obsidian only lists a file in the explorer when its
 * extension exists in `viewRegistry.typeByExtension` (`isSupportedFile`).
 * Registering the extension is therefore required for visibility, and a
 * registered extension must map to a real view type — hence the view.
 *
 * Verify : 1) `.xmind` shows up in the explorer carrying an "xmind" tag
 *          2) opening it shows the preview and launches NOTHING
 *             (autoOpen defaults to off)
 *          3) clicking the preview / the button launches the system app
 *          4) right-click -> "Open with system default app" does the same
 *          5) an archive without a preview still opens, just without a picture
 *          6) disabling the plugin removes the files again (no residue)
 */

// All guarded so a missing module degrades one feature instead of breaking
// the plugin's primary job (showing files and opening them).
let zlib = null;
let fs = null;
let childProcess = null;
try {
  zlib = require('zlib');
} catch (err) {
  zlib = null;
}
try {
  fs = require('fs');
} catch (err) {
  fs = null;
}
try {
  childProcess = require('child_process');
} catch (err) {
  childProcess = null;
}

const {
  Plugin,
  PluginSettingTab,
  Setting,
  FileView,
  Notice,
  TFile,
  setIcon,
} = require('obsidian');

// electron.shell is a fallback path only. Guarded so the plugin still loads
// if the module is unavailable in the current renderer.
let shell = null;
try {
  shell = require('electron').shell;
} catch (err) {
  shell = null;
}

const VIEW_TYPE = 'xmind-open-view';
const XMIND_EXT = 'xmind';

// Where XMind parks its pre-rendered map image.
const THUMBNAIL_ENTRY = 'Thumbnails/thumbnail.png';
// Past this the base64 data URI gets heavy enough to stall the renderer, and a
// preview is not worth a janky tab.
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;

const DEFAULT_SETTINGS = {
  // Off by default: opening a map should not yank focus into an external
  // window. The in-app preview covers the "just take a look" case.
  autoOpen: false,
  showThumbnail: true,
  // Empty = let the OS file association decide (the normal, recommended path).
  // Set it only when Windows has no handler for `.xmind`, or the wrong one.
  xmindPath: '',
};

/* -------------------------------------------------------------------------- *
 * Minimal ZIP reader
 * --------------------------------------------------------------------------
 * An .xmind file is a plain ZIP archive. Hand-rolled rather than vendoring a
 * zip library, because the plugin ships as a single main.js with no bundler
 * step and only ever reads one entry.
 *
 * ZIP64 is deliberately unsupported: mindmap archives never approach 4 GiB,
 * and degrading to "no preview" beats untested offset arithmetic.
 * -------------------------------------------------------------------------- */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const ZIP64_MARK = 0xffffffff;

/** Scan backwards for the End Of Central Directory record. */
function findEocd(view) {
  const lowest = Math.max(0, view.byteLength - 0xffff - 22);
  for (let pos = view.byteLength - 22; pos >= lowest; pos--) {
    if (view.getUint32(pos, true) === SIG_EOCD) return pos;
  }
  return -1;
}

/** Read the entry's payload from its local header and inflate it. */
function inflateEntry(view, buffer, localOffset, method, compressedSize) {
  if (localOffset + 30 > view.byteLength) return null;
  if (view.getUint32(localOffset, true) !== SIG_LOCAL) return null;

  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  if (start + compressedSize > view.byteLength) return null;

  const raw = new Uint8Array(buffer, start, compressedSize);
  if (method === 0) return raw; // stored
  if (method !== 8) return null; // only deflate is expected

  try {
    return new Uint8Array(zlib.inflateRawSync(raw));
  } catch (err) {
    return null; // corrupt entry -> the preview simply will not appear
  }
}

/** Extract one entry by exact name.
 *  Returns a Uint8Array, or null when the entry is absent or the archive uses
 *  an unsupported layout. Never throws — callers only lose the preview. */
function readZipEntry(buffer, wantedName) {
  if (!buffer || !zlib || buffer.byteLength < 22) return null;

  const view = new DataView(buffer);
  const decoder = new TextDecoder('utf-8');

  const eocd = findEocd(view);
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === ZIP64_MARK || count === 0xffff) return null;

  let cursor = cdOffset;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > view.byteLength) return null;
    if (view.getUint32(cursor, true) !== SIG_CENTRAL) return null;

    const method = view.getUint16(cursor + 10, true);
    // Sizes always come from the central directory: local headers may carry
    // zeros when a data descriptor is used.
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    const name = decoder.decode(new Uint8Array(buffer, cursor + 46, nameLength));
    if (name === wantedName) {
      return inflateEntry(view, buffer, localOffset, method, compressedSize);
    }

    if (compressedSize === ZIP64_MARK || localOffset === ZIP64_MARK) return null;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** Encode bytes as a data URI. Preferred over a Blob URL here: there is no
 *  lifecycle to manage, and it behaves identically in the headless harness. */
function toDataUri(bytes, mime) {
  return 'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64');
}

// `path@mtime` -> data URI, or null when the archive has no usable preview.
// Capped so a long browsing session cannot grow it without bound.
const thumbnailCache = new Map();
const THUMBNAIL_CACHE_LIMIT = 24;

async function loadThumbnail(app, file) {
  const key = file.path + '@' + file.stat.mtime;
  if (thumbnailCache.has(key)) return thumbnailCache.get(key);

  let uri = null;
  try {
    const buffer = await app.vault.readBinary(file);
    const png = readZipEntry(buffer, THUMBNAIL_ENTRY);
    if (png && png.byteLength > 0 && png.byteLength <= MAX_THUMBNAIL_BYTES) {
      uri = toDataUri(png, 'image/png');
    }
  } catch (err) {
    console.warn(t.logThumbnailFailed, err);
  }

  if (thumbnailCache.size >= THUMBNAIL_CACHE_LIMIT) thumbnailCache.clear();
  thumbnailCache.set(key, uri);
  return uri;
}

/* -------------------------------------------------------------------------- *
 * Localisation
 * --------------------------------------------------------------------------
 * The plugin is published internationally but its author works in a Chinese
 * UI. Rather than maintaining two divergent copies, every user-facing string
 * lives here and the locale is resolved once at load time from Obsidian's own
 * language setting. English is the fallback, so an unrecognised locale — and
 * therefore every user of the published build who is not on Chinese — gets the
 * English wording.
 * -------------------------------------------------------------------------- */

const STRINGS = {
  en: {
    appName: 'XMind',
    unknownSize: 'unknown size',

    launchPending: 'Launching the system application…',
    previewTitle: 'Click to open with the system default app',
    previewAlt: (name) => name + ' preview',
    openButton: 'Open with system default app',
    previewHint:
      'The preview image is the Thumbnails/thumbnail.png stored inside the .xmind archive. Mindmap data is never parsed.',

    noFile: 'No file to open',
    unresolvedPath: 'Could not resolve the absolute file path',
    openedViaAssociation: 'Handed off to the system default app',
    openedViaExecutable: 'Opened with the configured XMind',
    clearPathHint:
      ' (clear the path in settings to fall back to the system file association)',
    cannotSpawn: 'Cannot launch an external program in this environment',
    cannotOpenExternally: 'Cannot invoke a system application in this environment',
    executableMissing: (path) => 'The configured program does not exist: ' + path,
    openFailedNotice: (message) => 'Open failed: ' + message,
    menuOpen: 'Open with system default app',

    sourceAssociation: 'system file association',
    sourceCandidates: 'common install location',

    settingsTitle: 'XMind Open settings',
    autoOpenName: 'Open with the system app automatically',
    autoOpenDesc:
      'Off by default: opening a .xmind shows the preview and the button only, and XMind starts only when you click. Turn on to launch the system app as soon as a file is opened.',
    showThumbnailName: 'Show preview image',
    showThumbnailDesc:
      'Reads the preview image XMind stores inside the archive. That is only a picture — the mindmap contents are not read.',
    pathName: 'XMind executable path (usually leave empty)',
    pathDesc:
      'Leave empty to hand files to the Windows .xmind file association, so the plugin never needs to know where XMind is installed. Set a path only when the association is missing or has been taken over by another program.',
    pathPlaceholder: 'e.g. C:\\Program Files\\XMind\\XMind.exe',
    detectButton: 'Auto-detect',
    detectFailed:
      'XMind not found: the file association does not point to a valid program, and no common install location matched. Please enter the full path manually.',
    detectOk: (source, path) => 'Detected (' + source + '): ' + path,

    extensionsOk: '✅ .xmind is registered — these files appear in the file explorer.',
    extensionsTaken:
      '⚠️ .xmind is already registered by another plugin; showing these files is up to that plugin.',

    logExtensionTaken: '[xmind-open] ".xmind" is already registered, skipping registration.',
    logOpenFallback: '[xmind-open] openWithDefaultApp failed, falling back to electron.shell.',
    logThumbnailFailed: '[xmind-open] Could not read the preview image, skipping it.',
  },

  zh: {
    appName: 'XMind',
    unknownSize: '未知大小',

    launchPending: '正在启动系统程序…',
    previewTitle: '点击用系统默认程序打开',
    previewAlt: (name) => name + ' 预览图',
    openButton: '用系统默认程序打开',
    previewHint: '预览图取自 .xmind 内自带的 Thumbnails/thumbnail.png，不解析思维导图数据。',

    noFile: '没有可打开的文件',
    unresolvedPath: '无法解析文件的绝对路径',
    openedViaAssociation: '已交给系统默认程序打开',
    openedViaExecutable: '已用指定的 XMind 打开',
    clearPathHint: '（可在设置中清空该路径以改用系统关联）',
    cannotSpawn: '当前环境无法启动外部程序',
    cannotOpenExternally: '当前环境无法调用系统程序',
    executableMissing: (path) => '指定的程序不存在：' + path,
    openFailedNotice: (message) => '打开失败：' + message,
    menuOpen: '用系统默认程序打开',

    sourceAssociation: '系统文件关联',
    sourceCandidates: '常见安装位置',

    settingsTitle: 'XMind Open 设置',
    autoOpenName: '点击后自动用系统程序打开',
    autoOpenDesc:
      '默认关闭：打开 .xmind 时只显示预览与按钮，需手动点击才会启动 XMind。开启后打开文件即自动唤起系统程序。',
    showThumbnailName: '显示缩略图',
    showThumbnailDesc:
      '读取 .xmind 内自带的预览图。那只是 XMind 存好的一张图，不读取思维导图内容。',
    pathName: 'XMind 程序路径（一般留空）',
    pathDesc:
      '留空即可：默认把文件交给 Windows 的 .xmind 文件关联，由系统决定用哪个程序，插件无需知道 XMind 装在哪。只有在系统没有关联、或关联被别的程序抢走时，才需要在此指定。',
    pathPlaceholder: '例如 C:\\Program Files\\XMind\\XMind.exe',
    detectButton: '自动检测',
    detectFailed:
      '未检测到 XMind：系统关联未指向有效程序，常见安装位置也没有找到。请手动填写完整路径。',
    detectOk: (source, path) => '已检测到（' + source + '）：' + path,

    extensionsOk: '✅ .xmind 扩展名已注册，文件浏览器可正常显示。',
    extensionsTaken: '⚠️ .xmind 扩展名已被其它插件占用，文件浏览器中的显示由那个插件负责。',

    logExtensionTaken: '[xmind-open] ".xmind" 已被其它插件注册，跳过注册。',
    logOpenFallback: '[xmind-open] openWithDefaultApp 失败，改用 electron.shell。',
    logThumbnailFailed: '[xmind-open] 读取缩略图失败，跳过预览。',
  },
};

/** Obsidian stores its UI language in localStorage. Unknown locales fall back
 *  to English, which is what anyone outside a Chinese UI should see. */
function detectLocale() {
  try {
    const stored = window.localStorage.getItem('language');
    if (stored) return String(stored).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  } catch (err) {
    // No localStorage available — fall through to the navigator check.
  }
  try {
    // Prefer the renderer's own navigator. A bare global `navigator` would
    // read the *host* process language instead — wrong under a headless
    // harness, and pointlessly indirect inside the real app.
    const nav = typeof window !== 'undefined' && window.navigator ? window.navigator : null;
    if (nav && /^zh/i.test(nav.language || '')) return 'zh';
  } catch (err) {
    // ignore
  }
  return 'en';
}

const LOCALE = detectLocale();
const t = STRINGS[LOCALE];

/* -------------------------------------------------------------------------- *
 * Locating XMind (only for the optional custom-path mode)
 * -------------------------------------------------------------------------- */

// Common install locations, tried in order. `%VAR%` segments are expanded from
// the environment so a relocated Program Files still matches.
const XMIND_CANDIDATES = [
  '%ProgramFiles%\\XMind\\XMind.exe',
  '%ProgramFiles(x86)%\\XMind\\XMind.exe',
  '%LOCALAPPDATA%\\Programs\\XMind\\XMind.exe',
  '%LOCALAPPDATA%\\XMind\\XMind.exe',
  '%APPDATA%\\XMind\\XMind.exe',
];

function expandEnv(value) {
  return String(value).replace(/%([^%]+)%/g, (match, name) => {
    const hit = process.env[name];
    return hit === undefined ? match : hit;
  });
}

function fileExists(candidate) {
  if (!fs || !candidate) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch (err) {
    return false;
  }
}

/** Pull the executable out of a shell "open" command line:
 *  `"C:\Program Files\XMind\XMind.exe" "%1"` -> `C:\Program Files\XMind\XMind.exe` */
function extractExecutable(command) {
  if (!command) return null;
  const quoted = String(command).match(/"([^"]+\.exe)"/i);
  if (quoted) return quoted[1];
  const bare = String(command).match(/^\s*([^\s]+\.exe)/i);
  return bare ? bare[1] : null;
}

/** Read a registry key's default value through reg.exe.
 *  `reg.exe` writes in the console code page, so a path with non-ASCII
 *  characters can come back mangled — harmless here, because the caller
 *  verifies the path exists and a mangled one simply fails that check. */
function queryRegistryDefault(key) {
  if (!childProcess || typeof childProcess.execFile !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      childProcess.execFile(
        'reg',
        ['query', key, '/ve'],
        { windowsHide: true, timeout: 4000 },
        (err, stdout) => {
          if (err || !stdout) return resolve(null);
          const match = String(stdout).match(/REG_SZ\s+(.+?)\s*$/m);
          resolve(match ? match[1].trim() : null);
        }
      );
    } catch (err) {
      resolve(null);
    }
  });
}

/** Best-effort lookup of an XMind executable. Returns `{ path, source }` or
 *  null. Never throws — used only to prefill a settings field. */
async function detectXmindExecutable() {
  // 1) Whatever Windows would use for `.xmind` right now.
  const progId = await queryRegistryDefault('HKCR\\.xmind');
  if (progId) {
    const command = await queryRegistryDefault('HKCR\\' + progId + '\\shell\\open\\command');
    const exe = extractExecutable(command);
    if (exe && fileExists(exe)) return { path: exe, source: t.sourceAssociation };
  }

  // 2) Well-known install locations.
  for (const candidate of XMIND_CANDIDATES) {
    const expanded = expandEnv(candidate);
    if (fileExists(expanded)) return { path: expanded, source: t.sourceCandidates };
  }

  return null;
}

/** Launch `exe` with the file path as its single argument.
 *  Array-form spawn sidesteps every quoting question around spaces in paths. */
function launchWithExecutable(exe, target) {
  return new Promise((resolve) => {
    if (!childProcess || typeof childProcess.spawn !== 'function') {
      return resolve({ ok: false, message: t.cannotSpawn });
    }
    if (!fileExists(exe)) {
      return resolve({ ok: false, message: t.executableMissing(exe) });
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = childProcess.spawn(exe, [target], { detached: true, stdio: 'ignore' });
    } catch (err) {
      return finish({ ok: false, message: err.message });
    }

    if (typeof child.once === 'function') {
      child.once('error', (err) => finish({ ok: false, message: err.message }));
      child.once('spawn', () => finish({ ok: true, message: t.openedViaExecutable }));
    }
    if (typeof child.unref === 'function') child.unref();
  });
}

/** Resolve a vault-relative path to an absolute one without assuming which
 *  adapter is in use. Returns null when the path cannot be resolved. */
function resolveAbsolutePath(app, file) {
  const adapter = app.vault.adapter;
  if (adapter && typeof adapter.getFullPath === 'function') {
    try {
      const full = adapter.getFullPath(file.path);
      if (typeof full === 'string' && full) return full;
    } catch (err) {
      // fall through to basePath
    }
  }
  if (adapter && typeof adapter.basePath === 'string' && adapter.basePath) {
    return adapter.basePath.replace(/[\\/]+$/, '') + '/' + file.path;
  }
  return null;
}

function formatSize(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return t.unknownSize;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** Remove every child of `node` without relying on Obsidian's DOM helpers. */
function clearEl(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

class XmindFileView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.status = null;
    this.thumbnail = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return this.file ? this.file.name : t.appName;
  }

  getIcon() {
    return 'git-fork';
  }

  // FileView has already assigned `this.file` before calling this hook.
  async onLoadFile() {
    this.status = null;
    this.thumbnail = null;
    this.render();
    // Deliberately not awaited: decoding a preview must never delay the open.
    if (this.plugin.settings.showThumbnail) this.refreshThumbnail();
    if (this.plugin.settings.autoOpen) await this.openExternal();
  }

  async onUnloadFile() {
    this.status = null;
    this.thumbnail = null;
    clearEl(this.contentEl);
  }

  async onOpen() {
    if (this.file) this.render();
  }

  /** Load the preview in the background. If the user has already switched to
   *  another file by the time it resolves, the result is discarded. */
  async refreshThumbnail() {
    const file = this.file;
    if (!file) return;
    const uri = await loadThumbnail(this.app, file);
    if (this.file !== file) return;
    this.thumbnail = uri;
    this.render();
  }

  async openExternal() {
    if (!this.file) return;
    this.status = { ok: true, pending: true, message: t.launchPending };
    this.render();
    this.status = await this.plugin.openExternally(this.file);
    this.render();
  }

  // Deliberately plain DOM: Obsidian's `createDiv/createEl/empty/addClass`
  // helpers do not exist outside the real app, which would make this view
  // impossible to exercise in a headless harness.
  render() {
    const root = this.contentEl;
    clearEl(root);
    root.classList.add('xmind-open-view');
    if (!this.file) return;

    const add = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      root.appendChild(node);
      return node;
    };

    if (this.thumbnail) {
      const img = add('img', 'xmind-open-view__thumb');
      img.src = this.thumbnail;
      img.alt = t.previewAlt(this.file.name);
      img.title = t.previewTitle;
      img.addEventListener('click', () => this.openExternal());
    } else {
      // No preview available (or still loading): fall back to the glyph.
      setIcon(add('div', 'xmind-open-view__icon'), 'git-fork');
    }

    add('div', 'xmind-open-view__name', this.file.name);
    add(
      'div',
      'xmind-open-view__meta',
      this.file.path + ' · ' + formatSize(this.file.stat.size)
    );

    const button = add('button', 'mod-cta xmind-open-view__button', t.openButton);
    button.addEventListener('click', () => this.openExternal());

    if (this.status) {
      add(
        'div',
        'xmind-open-view__status' + (this.status.ok ? ' is-ok' : ' is-error'),
        this.status.message
      );
    }

    add('div', 'xmind-open-view__hint', t.previewHint);
  }
}

class XmindOpenSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    clearEl(containerEl);

    const heading = document.createElement('h2');
    heading.textContent = t.settingsTitle;
    containerEl.appendChild(heading);

    new Setting(containerEl)
      .setName(t.autoOpenName)
      .setDesc(t.autoOpenDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoOpen).onChange(async (value) => {
          this.plugin.settings.autoOpen = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t.showThumbnailName)
      .setDesc(t.showThumbnailDesc)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showThumbnail).onChange(async (value) => {
          this.plugin.settings.showThumbnail = value;
          await this.plugin.saveSettings();
        })
      );

    const detectResult = document.createElement('div');
    detectResult.className = 'xmind-open-detect-result';

    let pathField = null;
    new Setting(containerEl)
      .setName(t.pathName)
      .setDesc(t.pathDesc)
      .addText((text) => {
        pathField = text;
        return text
          .setPlaceholder(t.pathPlaceholder)
          .setValue(this.plugin.settings.xmindPath)
          .onChange(async (value) => {
            this.plugin.settings.xmindPath = value.trim();
            await this.plugin.saveSettings();
          });
      })
      .addButton((button) =>
        button.setButtonText(t.detectButton).onClick(async () => {
          const found = await detectXmindExecutable();
          if (!found) {
            detectResult.textContent = t.detectFailed;
            detectResult.className = 'xmind-open-detect-result is-error';
            return;
          }
          this.plugin.settings.xmindPath = found.path;
          await this.plugin.saveSettings();
          if (pathField) pathField.setValue(found.path);
          detectResult.textContent = t.detectOk(found.source, found.path);
          detectResult.className = 'xmind-open-detect-result is-ok';
        })
      );

    containerEl.appendChild(detectResult);

    const state = document.createElement('div');
    state.className = 'xmind-open-setting-state';
    state.textContent = this.plugin.extensionsRegistered ? t.extensionsOk : t.extensionsTaken;
    containerEl.appendChild(state);
  }
}

class XmindOpenPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.extensionsRegistered = false;

    this.registerView(VIEW_TYPE, (leaf) => new XmindFileView(leaf, this));

    // Registering the extension is what makes .xmind visible in the explorer.
    // Obsidian throws when the extension is already taken, so this must be
    // guarded — otherwise the whole plugin would fail to load.
    try {
      this.registerExtensions([XMIND_EXT], VIEW_TYPE);
      this.extensionsRegistered = true;
    } catch (err) {
      console.warn(t.logExtensionTaken, err);
    }

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== XMIND_EXT) return;
        menu.addItem((item) =>
          item
            .setTitle(t.menuOpen)
            .setIcon('lucide-external-link')
            .setSection('open')
            .onClick(async () => {
              const result = await this.openExternally(file);
              if (!result.ok) new Notice(t.openFailedNotice(result.message));
            })
        );
      })
    );

    this.addSettingTab(new XmindOpenSettingTab(this.app, this));
  }

  /** Launch the OS-registered handler for a .xmind file.
   *  Returns `{ ok, message }` — never throws, so callers can render the
   *  outcome instead of guarding every call site. */
  async openExternally(file) {
    if (!file) return { ok: false, message: t.noFile };

    const configured = String(this.settings.xmindPath || '').trim();

    // 1) An explicit path wins. The user set it precisely because the OS
    //    association does not work, so silently falling back would hide the
    //    very problem they were trying to solve.
    if (configured) {
      const absolute = resolveAbsolutePath(this.app, file);
      if (!absolute) return { ok: false, message: t.unresolvedPath };
      const launched = await launchWithExecutable(configured, absolute);
      if (launched.ok) return launched;
      return { ok: false, message: launched.message + t.clearPathHint };
    }

    // 2) Default: hand the *file* to the OS and let the `.xmind` association
    //    pick the program — no executable path involved.
    //    Obsidian's own helper is preferred: it resolves the vault-relative
    //    path and reports OS-level failures. Undocumented, so probe first.
    if (typeof this.app.openWithDefaultApp === 'function') {
      try {
        const ret = this.app.openWithDefaultApp(file.path);
        if (ret && typeof ret.then === 'function') await ret;
        return { ok: true, message: t.openedViaAssociation };
      } catch (err) {
        console.warn(t.logOpenFallback, err);
      }
    }

    if (!shell || typeof shell.openPath !== 'function') {
      return { ok: false, message: t.cannotOpenExternally };
    }

    const absolute = resolveAbsolutePath(this.app, file);
    if (!absolute) return { ok: false, message: t.unresolvedPath };

    const failure = await shell.openPath(absolute);
    return failure
      ? { ok: false, message: failure }
      : { ok: true, message: t.openedViaAssociation };
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = XmindOpenPlugin;

// Test hooks — the Obsidian runtime never reads this field.
module.exports.__test = {
  STRINGS,
  LOCALE,
  detectLocale,
  resolveAbsolutePath,
  formatSize,
  readZipEntry,
  toDataUri,
  thumbnailCache,
  detectXmindExecutable,
  extractExecutable,
  expandEnv,
  launchWithExecutable,
  fileExists,
  XMIND_CANDIDATES,
  VIEW_TYPE,
  XMIND_EXT,
  THUMBNAIL_ENTRY,
};
