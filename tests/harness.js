'use strict';

/**
 * Offline harness for the `xmind-open` Obsidian plugin.
 *
 * Stubs the `obsidian` module by intercepting Module._load (never by
 * string-patching the source), supplies a jsdom document, and emulates the
 * runtime pieces the plugin actually touches: the view registry, extension
 * registration, Leaf.openFile dispatch, and the FileView lifecycle.
 *
 * The FileView emulation mirrors the real implementation decompiled from
 * obsidian.asar: bind `this.file` -> await onLoadFile -> swallow load errors
 * -> refresh the title. Keeping it faithful matters, because the plugin relies
 * on the parent to assign `this.file` before `onLoadFile` runs.
 *
 * XMO_MAIN env var overrides which main.js is loaded (used by mutate.js).
 */

const path = require('path');
const Module = require('module');

/** jsdom is a dev-only dependency. Prefer the normal module lookup so CI and
 *  a plain `npm install` work; fall back to the author's isolated runtime. */
function loadJsdom() {
  try {
    return require('jsdom');
  } catch (err) {
    return require(
      path.join('C:/Users/NOYI/.workbuddy/binaries/node/workspace/node_modules', 'jsdom')
    );
  }
}

const { JSDOM } = loadJsdom();

// Resolved relative to tests/ so the suite runs from any checkout — including
// CI, where the author's absolute paths do not exist.
const PLUGIN_MAIN = path.join(__dirname, '..', 'main.js');
const MAIN_PATH = process.env.XMO_MAIN || PLUGIN_MAIN;

function createObsidianStub(env) {
  const notices = [];

  class TAbstractFile {
    constructor(p) {
      this.path = p;
      this.name = p.split('/').pop();
      const dot = this.name.lastIndexOf('.');
      this.extension = dot > 0 ? this.name.slice(dot + 1) : '';
      this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    }
  }

  class TFile extends TAbstractFile {
    constructor(p, content) {
      super(p);
      this._content = toBuffer(content);
      this.stat = { size: this._content.byteLength, ctime: 0, mtime: 0 };
    }
  }

  class TFolder extends TAbstractFile {}

  class View {
    constructor(leaf) {
      this.leaf = leaf;
      this.app = leaf.app;
      this.containerEl = document.createElement('div');
      this.contentEl = document.createElement('div');
      this.titleEl = document.createElement('div');
    }
  }

  class ItemView extends View {
    async onOpen() {}
    async onClose() {}
    getViewType() { return ''; }
    getDisplayText() { return ''; }
    getIcon() { return ''; }
  }

  class FileView extends ItemView {
    constructor(leaf) {
      super(leaf);
      this.file = null;
    }
    async onLoadFile() {}
    async onUnloadFile() {}
    renderBreadcrumbs() {}
    async loadFile(file) {
      if (this.file === file) return false;
      if (this.file) await this.onUnloadFile(this.file);
      this.file = null;
      if (file) {
        try {
          this.file = file;
          await this.onLoadFile(file);
        } catch (err) {
          this.file = null;
          notices.push('Failed to load file: ' + file.path);
          console.error('[harness] onLoadFile threw:', err);
        }
      }
      this.titleEl.textContent = this.getDisplayText();
      return true;
    }
    async setState(state) {
      const f = state && state.file ? this.app.vault.getAbstractFileByPath(state.file) : null;
      return this.loadFile(f);
    }
  }

  class Notice {
    constructor(message) { notices.push(message); }
  }

  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this._cleanups = [];
    }
    register(cb) { this._cleanups.push(cb); return cb; }
    registerView(type, creator) { env.views.push({ type, creator }); }
    registerExtensions(exts, type) {
      for (const e of exts) {
        if (env.takenExtensions.includes(e)) {
          throw new Error('Attempting to register an existing file extension "' + e + '"');
        }
      }
      env.registered.push({ exts, type });
      exts.forEach((e) => { env.extensionTypes[e] = type; });
    }
    registerEvent(ref) { return ref; }
    addSettingTab(tab) { env.settingTabs.push(tab); }
    addCommand(cmd) { env.commands.push(cmd); }
    async loadData() { return env.data; }
    async saveData(d) { env.saved = d; }
  }

  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = document.createElement('div');
    }
    display() {}
  }

  class Setting {
    constructor(containerEl) {
      this.containerEl = containerEl;
      this.toggles = [];
      this.texts = [];
      this.buttons = [];
      (env.settingComponents = env.settingComponents || []).push(this);
    }
    setName(n) { this.name = n; return this; }
    setDesc(d) { this.desc = d; return this; }
    setTitle(t) { this.title = t; return this; }
    setIcon() { return this; }
    setSection() { return this; }
    onClick(cb) { this.clickCb = cb; return this; }
    addToggle(cb) {
      const toggle = {
        value: null,
        setValue(v) { this.value = v; return this; },
        onChange(fn) { this.changeCb = fn; return this; },
      };
      this.toggles.push(toggle);
      cb(toggle);
      return this;
    }
    addText(cb) {
      const text = {
        value: '',
        placeholder: null,
        setPlaceholder(v) { this.placeholder = v; return this; },
        setValue(v) { this.value = v; return this; },
        onChange(fn) { this.changeCb = fn; return this; },
      };
      this.texts.push(text);
      cb(text);
      return this;
    }
    addButton(cb) {
      const button = {
        text: null,
        setButtonText(v) { this.text = v; return this; },
        setCta() { return this; },
        setTooltip() { return this; },
        setDisabled() { return this; },
        onClick(fn) { this.clickCb = fn; return this; },
      };
      this.buttons.push(button);
      cb(button);
      return this;
    }
  }

  function setIcon(el, id) { el.dataset.icon = id; }

  return {
    Plugin, PluginSettingTab, Setting, FileView, ItemView, View, Notice,
    TFile, TFolder, TAbstractFile, setIcon, _notices: notices,
  };
}

/* --------------------------------------------------------------------------
 * ZIP fixture builder
 * --------------------------------------------------------------------------
 * Lets the suite fabricate .xmind-shaped archives in memory (with or without a
 * thumbnail, deflated or stored) instead of depending on external files.
 * The *decoder* is cross-checked against a real archive by
 * verify-thumbnail.js, so this encoder is not grading its own homework.
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function toBuffer(content) {
  if (content == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  if (ArrayBuffer.isView(content)) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  }
  return Buffer.from(String(content), 'utf8');
}

/** Build a ZIP archive. `entries` = [{ name, data, store? }] */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = toBuffer(entry.data);
    const method = entry.store ? 0 : 8;
    const payload = entry.store ? raw : zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, nameBuf, payload);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat(parts.concat([centralBuf, eocd]));
}

function makeMenu() {
  const menu = {
    items: [],
    addItem(cb) {
      const item = {
        title: null, icon: null, section: null, clickCb: null,
        setTitle(t) { this.title = t; return this; },
        setIcon(i) { this.icon = i; return this; },
        setSection(s) { this.section = s; return this; },
        onClick(fn) { this.clickCb = fn; return this; },
      };
      cb(item);
      menu.items.push(item);
      return item;
    },
  };
  return menu;
}

function loadPlugin(overrides) {
  const env = Object.assign({
    files: {},
    takenExtensions: [],
    noElectron: false,
    openPath: async () => '',
    openWithDefaultApp: undefined,
    adapter: undefined,
    data: {},
  }, overrides);

  env.views = [];
  env.registered = [];
  env.extensionTypes = {};
  env.settingTabs = [];
  env.commands = [];
  env.saved = null;
  env.defaultOpened = [];
  env.readBinaryCalls = [];

  // Fresh document per load so tests never share DOM state.
  // A concrete origin is required: jsdom disables localStorage on opaque
  // origins (about:blank), and the plugin's locale lookup reads from it.
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://obsidian.local/',
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.Event = dom.window.Event;

  // Obsidian resolves its UI language from localStorage. Pin it so the suite
  // always asserts against a known locale, whatever the host machine uses.
  // `locale: null` deliberately leaves it unset, to exercise the fallback.
  if (env.locale !== null) {
    dom.window.localStorage.setItem('language', env.locale || 'zh');
  }

  const stub = createObsidianStub(env);

  const files = new Map();
  for (const [p, content] of Object.entries(env.files)) {
    files.set(p, new stub.TFile(p, content));
  }

  const vault = {
    adapter: env.adapter !== undefined ? env.adapter : {
      getFullPath: (rel) => 'C:/vault/' + rel,
      basePath: 'C:/vault',
    },
    getAbstractFileByPath: (p) => files.get(p) || null,
    getConfig: () => false,
    on: () => ({}),
    // Obsidian hands the plugin a standalone ArrayBuffer, not a Node Buffer.
    // Mirroring that exactly is what keeps the ZIP reader honest.
    readBinary: async (file) => {
      env.readBinaryCalls.push(file.path);
      // Per-path delay lets a test keep one file's read "in flight" while the
      // view has already moved on — the only way to observe a stale result.
      const perPath = env.readBinaryDelayByPath && env.readBinaryDelayByPath[file.path];
      const delay = perPath != null ? perPath : env.readBinaryDelay;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const buf = file._content || Buffer.alloc(0);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    read: async (file) => (file._content || Buffer.alloc(0)).toString('utf8'),
  };

  const menuHandlers = [];
  const workspace = {
    on(name, cb) { if (name === 'file-menu') menuHandlers.push(cb); return { name, cb }; },
    triggerFileMenu(menu, file) { menuHandlers.forEach((cb) => cb(menu, file)); },
    getLeaf: () => null,
    getActiveFile: () => null,
  };

  const app = { vault, workspace };
  if (env.openWithDefaultApp) app.openWithDefaultApp = env.openWithDefaultApp;

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'obsidian') return stub;
    if (request === 'electron') {
      if (env.noElectron) throw new Error("Cannot find module 'electron'");
      return { shell: { openPath: env.openPath } };
    }
    // Intercepted only when a test injects a stub. Otherwise the real module is
    // used, so the fs-backed existence checks stay honest.
    if (request === 'child_process' && env.childProcess) return env.childProcess;
    return origLoad.apply(this, arguments);
  };

  delete require.cache[require.resolve(MAIN_PATH)];
  let PluginClass;
  try {
    PluginClass = require(MAIN_PATH);
  } finally {
    Module._load = origLoad;
  }

  const plugin = new PluginClass(app, { id: 'xmind-open', version: '1.0.0' });

  /** Emulates Leaf.openFile: extension -> viewType -> creator -> setState. */
  async function openFile(file) {
    const type = env.extensionTypes[file.extension];
    if (!type) {
      // Real Obsidian falls back to the OS handler when no view is registered.
      env.defaultOpened.push(file.path);
      return null;
    }
    const entry = env.views.find((v) => v.type === type);
    if (!entry) throw new Error('no view creator registered for ' + type);
    const leaf = { app };
    const view = entry.creator(leaf);
    leaf.view = view;
    await view.setState({ file: file.path });
    return view;
  }

  return { plugin, PluginClass, app, stub, env, files, openFile, menuHandlers };
}

module.exports = { loadPlugin, makeMenu, makeZip, crc32, PLUGIN_MAIN, MAIN_PATH };
