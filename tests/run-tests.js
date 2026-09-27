'use strict';

/**
 * Offline test suite for the `xmind-open` Obsidian plugin.
 *
 * Three layers, matching the skill's requirements:
 *   A. pure functions        — resolveAbsolutePath / formatSize
 *   B. plugin bootstrap      — extension registration, view, settings
 *   C. degraded bootstrap    — extension already taken by another plugin
 *   D. view rendering        — DOM structure the user actually sees
 *   E. open hand-off         — app.openWithDefaultApp -> electron.shell chain
 *   F. autoOpen off + click  — the manual path
 *   G. file context menu     — only .xmind files, click really opens
 *   H. settings tab          — toggle writes back to data.json
 *   I. thumbnail preview     — unzip Thumbnails/thumbnail.png, cache, fallbacks
 *   J. real archive          — end-to-end against the on-disk sample map
 *   K. custom exe path       — direct launch, plus the "auto detect" button
 *
 * Exit code is 1 when anything fails, so mutate.js can assert on it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadPlugin, makeMenu, makeZip, MAIN_PATH } = require('./harness.js');

let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok    ' + name);
  } catch (err) {
    fail++;
    console.log('  FAIL  ' + name);
    console.log('        ' + String(err.message).split('\n').join('\n        '));
  }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const XMIND_FILE = '学习/Tool/Houdini/Houdini.xmind';

async function sectionA() {
  console.log('\n[A] 纯函数');
  const { PluginClass } = loadPlugin({});
  const { resolveAbsolutePath, formatSize } = PluginClass.__test;
  assert.ok(resolveAbsolutePath && formatSize, '__test 钩子缺失');

  await check('getFullPath 优先于 basePath', () => {
    const app = { vault: { adapter: { getFullPath: () => 'C:/vault/a.xmind', basePath: 'C:/other' } } };
    assert.strictEqual(resolveAbsolutePath(app, { path: 'a.xmind' }), 'C:/vault/a.xmind');
  });

  await check('getFullPath 抛错时回落 basePath', () => {
    const app = { vault: { adapter: { getFullPath: () => { throw new Error('nope'); }, basePath: 'C:/vault' } } };
    assert.strictEqual(resolveAbsolutePath(app, { path: 'sub/a.xmind' }), 'C:/vault/sub/a.xmind');
  });

  await check('basePath 尾随斜杠被规范化', () => {
    const app = { vault: { adapter: { basePath: 'C:/vault//' } } };
    assert.strictEqual(resolveAbsolutePath(app, { path: 'a.xmind' }), 'C:/vault/a.xmind');
  });

  await check('无可用 adapter 时返回 null', () => {
    assert.strictEqual(resolveAbsolutePath({ vault: { adapter: {} } }, { path: 'a.xmind' }), null);
  });

  await check('formatSize 边界', () => {
    assert.strictEqual(formatSize(0), '0 B');
    assert.strictEqual(formatSize(1023), '1023 B');
    assert.strictEqual(formatSize(1024), '1.0 KB');
    assert.strictEqual(formatSize(1024 * 1024), '1.0 MB');
    assert.strictEqual(formatSize(undefined), '未知大小');
    assert.strictEqual(formatSize(-5), '未知大小');
  });
}

async function sectionB() {
  console.log('\n[B] 加载与扩展名注册');
  const l = loadPlugin({});
  let threw = null;
  try {
    await l.plugin.onload();
  } catch (err) {
    threw = err;
  }

  await check('onload 不抛异常', () => assert.strictEqual(threw, null));
  await check('注册 xmind -> xmind-open-view', () => {
    assert.strictEqual(l.env.registered.length, 1);
    assert.deepStrictEqual(l.env.registered[0], { exts: ['xmind'], type: 'xmind-open-view' });
  });
  await check('extensionsRegistered = true', () => {
    assert.strictEqual(l.plugin.extensionsRegistered, true);
  });
  await check('注册了视图创建器', () => {
    assert.strictEqual(l.env.views.length, 1);
    assert.strictEqual(l.env.views[0].type, 'xmind-open-view');
  });
  await check('注册了 file-menu 监听', () => assert.strictEqual(l.menuHandlers.length, 1));
  await check('注册了设置面板', () => assert.strictEqual(l.env.settingTabs.length, 1));
  await check('默认 autoOpen = false（打开文件不唤起外部程序）', () => {
    assert.strictEqual(l.plugin.settings.autoOpen, false);
  });
  await check('默认 showThumbnail = true', () => {
    assert.strictEqual(l.plugin.settings.showThumbnail, true);
  });

  await check('loadData 覆盖两个默认值', async () => {
    const l2 = loadPlugin({ data: { autoOpen: true, showThumbnail: false } });
    await l2.plugin.onload();
    assert.strictEqual(l2.plugin.settings.autoOpen, true);
    assert.strictEqual(l2.plugin.settings.showThumbnail, false);
  });

  await check('注册扩展名后该扩展有了 viewType', () => {
    assert.strictEqual(l.env.extensionTypes.xmind, 'xmind-open-view');
  });
}

async function sectionC() {
  console.log('\n[C] 扩展名被其它插件占用时降级');
  const l = loadPlugin({ takenExtensions: ['xmind'] });
  let threw = null;
  try {
    await l.plugin.onload();
  } catch (err) {
    threw = err;
  }

  await check('冲突时 onload 仍不抛异常', () => assert.strictEqual(threw, null));
  await check('extensionsRegistered = false', () => {
    assert.strictEqual(l.plugin.extensionsRegistered, false);
  });
  await check('视图与菜单照常注册，功能不受损', () => {
    assert.strictEqual(l.env.views.length, 1);
    assert.strictEqual(l.menuHandlers.length, 1);
  });
  await check('设置面板如实报告冲突', () => {
    const tab = l.env.settingTabs[0];
    tab.display();
    const state = tab.containerEl.querySelector('.xmind-open-setting-state');
    assert.ok(state, '缺少状态行');
    assert.match(state.textContent, /已被其它插件占用/);
  });
}

async function sectionD() {
  console.log('\n[D] 视图渲染');
  const opened = [];
  const l = loadPlugin({
    files: { [XMIND_FILE]: 'x'.repeat(2048) },
    // autoOpen is off by default now, so opt in explicitly for this case.
    data: { autoOpen: true },
    openWithDefaultApp: (p) => { opened.push(p); },
  });
  await l.plugin.onload();

  const file = l.app.vault.getAbstractFileByPath(XMIND_FILE);
  const view = await l.openFile(file);
  const root = view.contentEl;

  await check('file 已被父类绑定', () => assert.strictEqual(view.file, file));
  await check('getDisplayText 返回文件名', () => {
    assert.strictEqual(view.getDisplayText(), 'Houdini.xmind');
  });
  await check('tab 标题被同步', () => assert.strictEqual(view.titleEl.textContent, 'Houdini.xmind'));
  await check('根容器带样式类', () => assert.ok(root.classList.contains('xmind-open-view')));
  await check('渲染文件名', () => {
    assert.strictEqual(root.querySelector('.xmind-open-view__name').textContent, 'Houdini.xmind');
  });
  await check('渲染路径 + 大小', () => {
    const meta = root.querySelector('.xmind-open-view__meta').textContent;
    assert.ok(meta.includes(XMIND_FILE), meta);
    assert.ok(meta.includes('2.0 KB'), meta);
  });
  await check('渲染打开按钮', () => {
    assert.strictEqual(root.querySelector('.xmind-open-view__button').textContent, '用系统默认程序打开');
  });
  await check('渲染图标', () => {
    assert.strictEqual(root.querySelector('.xmind-open-view__icon').dataset.icon, 'git-fork');
  });
  await check('渲染免责说明', () => {
    assert.ok(root.querySelector('.xmind-open-view__hint').textContent.includes('不解析'));
  });
  await check('autoOpen=true 时自动调用外部程序', () => {
    assert.deepStrictEqual(opened, [XMIND_FILE]);
  });
  await check('打开空路径时清空且不留残留节点', async () => {
    await view.setState({ file: 'nope.xmind' });
    assert.strictEqual(view.file, null);
    assert.strictEqual(root.querySelector('.xmind-open-view__name'), null);
  });
  await check('重复渲染不累积节点', async () => {
    await view.setState({ file: XMIND_FILE });
    const before = root.children.length;
    view.render();
    view.render();
    assert.ok(before >= 5, '首次渲染节点数异常: ' + before);
    assert.strictEqual(root.children.length, before);
  });
}

async function sectionE() {
  console.log('\n[E] 打开链：openWithDefaultApp -> electron.shell');
  const A = 'a.xmind';

  await check('优先用 app.openWithDefaultApp（vault 相对路径）', async () => {
    const calls = [];
    const l = loadPlugin({ files: { [A]: 'x' }, openWithDefaultApp: (p) => { calls.push(p); } });
    await l.plugin.onload();
    const r = await l.plugin.openExternally(l.app.vault.getAbstractFileByPath(A));
    assert.deepStrictEqual(calls, [A]);
    assert.strictEqual(r.ok, true);
  });

  await check('openWithDefaultApp 同步抛错时回退 shell（绝对路径）', async () => {
    const abs = [];
    const l = loadPlugin({
      files: { [A]: 'x' },
      openWithDefaultApp: () => { throw new Error('boom'); },
      openPath: async (p) => { abs.push(p); return ''; },
    });
    await l.plugin.onload();
    const r = await l.plugin.openExternally(l.app.vault.getAbstractFileByPath(A));
    assert.deepStrictEqual(abs, ['C:/vault/' + A]);
    assert.strictEqual(r.ok, true);
  });

  await check('openWithDefaultApp 异步 reject 时也回退', async () => {
    const abs = [];
    const l = loadPlugin({
      files: { [A]: 'x' },
      openWithDefaultApp: () => Promise.reject(new Error('async boom')),
      openPath: async (p) => { abs.push(p); return ''; },
    });
    await l.plugin.onload();
    const r = await l.plugin.openExternally(l.app.vault.getAbstractFileByPath(A));
    assert.deepStrictEqual(abs, ['C:/vault/' + A]);
    assert.strictEqual(r.ok, true);
  });

  await check('shell 返回错误串时 ok:false 且带原因', async () => {
    const l = loadPlugin({
      files: { [A]: 'x' },
      openPath: async () => 'No application is associated with this file',
    });
    await l.plugin.onload();
    const r = await l.plugin.openExternally(l.app.vault.getAbstractFileByPath(A));
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /No application/);
  });

  await check('无 electron 时返回 ok:false 而非抛异常', async () => {
    const l = loadPlugin({ files: { [A]: 'x' }, noElectron: true });
    await l.plugin.onload();
    const r = await l.plugin.openExternally(l.app.vault.getAbstractFileByPath(A));
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /无法调用系统程序/);
  });

  await check('路径无法解析时报错而非崩溃', async () => {
    const l = loadPlugin({ files: { [A]: 'x' }, adapter: {} });
    await l.plugin.onload();
    const r = await l.plugin.openExternally(l.app.vault.getAbstractFileByPath(A));
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /绝对路径/);
  });

  await check('file 为 null 时不崩溃', async () => {
    const l = loadPlugin({});
    await l.plugin.onload();
    const r = await l.plugin.openExternally(null);
    assert.strictEqual(r.ok, false);
  });
}

async function sectionF() {
  console.log('\n[F] autoOpen=false 与手动点击');
  const calls = [];
  const l = loadPlugin({
    data: { autoOpen: false },
    files: { [XMIND_FILE]: 'x' },
    openWithDefaultApp: (p) => { calls.push(p); },
  });
  await l.plugin.onload();
  const view = await l.openFile(l.app.vault.getAbstractFileByPath(XMIND_FILE));

  await check('autoOpen=false 时不自动打开', () => assert.strictEqual(calls.length, 0));
  await check('视图仍渲染出按钮', () => {
    assert.ok(view.contentEl.querySelector('.xmind-open-view__button'));
  });

  view.contentEl.querySelector('.xmind-open-view__button').click();
  await tick();

  await check('点击按钮触发打开', () => assert.deepStrictEqual(calls, [XMIND_FILE]));
  await check('状态行显示成功且带 is-ok', () => {
    const s = view.contentEl.querySelector('.xmind-open-view__status');
    assert.ok(s, '缺少状态行');
    assert.match(s.textContent, /已交给系统默认程序打开/);
    assert.ok(s.className.includes('is-ok'), s.className);
  });

  await check('失败时状态行带 is-error', async () => {
    const l2 = loadPlugin({
      data: { autoOpen: false },
      files: { [XMIND_FILE]: 'x' },
      noElectron: true,
    });
    await l2.plugin.onload();
    const v2 = await l2.openFile(l2.app.vault.getAbstractFileByPath(XMIND_FILE));
    v2.contentEl.querySelector('.xmind-open-view__button').click();
    await tick();
    const s = v2.contentEl.querySelector('.xmind-open-view__status');
    assert.ok(s, '缺少状态行');
    assert.ok(s.className.includes('is-error'), s.className);
  });
}

async function sectionG() {
  console.log('\n[G] 文件右键菜单');

  await check('.xmind 加入「用系统默认程序打开」', async () => {
    const l = loadPlugin({ files: { 'a.xmind': 'x', 'b.md': 'y' } });
    await l.plugin.onload();
    const menu = makeMenu();
    l.menuHandlers.forEach((h) => h(menu, l.app.vault.getAbstractFileByPath('a.xmind')));
    assert.strictEqual(menu.items.length, 1);
    assert.strictEqual(menu.items[0].title, '用系统默认程序打开');
    assert.strictEqual(menu.items[0].section, 'open');
  });

  await check('非 .xmind 文件不受影响', async () => {
    const l = loadPlugin({ files: { 'a.xmind': 'x', 'b.md': 'y' } });
    await l.plugin.onload();
    const menu = makeMenu();
    l.menuHandlers.forEach((h) => h(menu, l.app.vault.getAbstractFileByPath('b.md')));
    assert.strictEqual(menu.items.length, 0);
  });

  await check('文件夹不会误加菜单项', async () => {
    const l = loadPlugin({ files: { 'a.xmind': 'x' } });
    await l.plugin.onload();
    const menu = makeMenu();
    const folder = new l.stub.TFolder('学习');
    l.menuHandlers.forEach((h) => h(menu, folder));
    assert.strictEqual(menu.items.length, 0);
  });

  await check('菜单点击真的调用系统打开', async () => {
    const abs = [];
    const l = loadPlugin({
      files: { 'a.xmind': 'x' },
      openPath: async (p) => { abs.push(p); return ''; },
    });
    await l.plugin.onload();
    const menu = makeMenu();
    l.menuHandlers.forEach((h) => h(menu, l.app.vault.getAbstractFileByPath('a.xmind')));
    await menu.items[0].clickCb();
    assert.deepStrictEqual(abs, ['C:/vault/a.xmind']);
  });
}

async function sectionH() {
  console.log('\n[H] 设置面板');

  await check('渲染标题与状态行', async () => {
    const l = loadPlugin({});
    await l.plugin.onload();
    const tab = l.env.settingTabs[0];
    tab.display();
    assert.ok(tab.containerEl.querySelector('h2'), '缺少标题');
    assert.match(
      tab.containerEl.querySelector('.xmind-open-setting-state').textContent,
      /已注册/
    );
  });

  await check('两个开关的名称与初值都正确', async () => {
    const l = loadPlugin({});
    await l.plugin.onload();
    const tab = l.env.settingTabs[0];
    tab.display();
    const toggles = l.env.settingComponents.filter((s) => s.toggles.length);
    assert.strictEqual(toggles.length, 2, '应有 2 个开关');
    // Assert the names too: index-based lookup silently drifts if rows reorder.
    assert.strictEqual(toggles[0].name, '点击后自动用系统程序打开');
    assert.strictEqual(toggles[0].toggles[0].value, false);
    assert.strictEqual(toggles[1].name, '显示缩略图');
    assert.strictEqual(toggles[1].toggles[0].value, true);
  });

  await check('切换开关写回 settings 与 data.json', async () => {
    const l = loadPlugin({});
    await l.plugin.onload();
    const tab = l.env.settingTabs[0];
    tab.display();
    const toggles = l.env.settingComponents.filter((s) => s.toggles.length);
    await toggles[0].toggles[0].changeCb(true);
    await toggles[1].toggles[0].changeCb(false);
    assert.strictEqual(l.plugin.settings.autoOpen, true);
    assert.strictEqual(l.plugin.settings.showThumbnail, false);
    assert.ok(l.env.saved, '未调用 saveData');
    assert.strictEqual(l.env.saved.autoOpen, true);
    assert.strictEqual(l.env.saved.showThumbnail, false);
  });
}

async function sectionI() {
  console.log('\n[I] 缩略图预览');

  const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const png12 = Buffer.concat([Buffer.from(PNG_HEAD), Buffer.alloc(4, 0xab)]);
  const FILE = 'map.xmind';

  const thumbZip = makeZip([
    { name: 'content.json', data: '{"sheet":{}}' },
    { name: 'Thumbnails/thumbnail.png', data: png12 },
  ]);
  const noThumbZip = makeZip([{ name: 'content.json', data: '{}' }]);

  /** Boot the plugin, open FILE, and let the async preview settle. */
  async function open(archive, settings, extra) {
    const l = loadPlugin(
      Object.assign({ files: { [FILE]: archive }, data: settings || {} }, extra || {})
    );
    await l.plugin.onload();
    const view = await l.openFile(l.app.vault.getAbstractFileByPath(FILE));
    await tick(20);
    return { l, view };
  }

  await check('渲染缩略图为 data URI 图片', async () => {
    const { view } = await open(thumbZip);
    const img = view.contentEl.querySelector('.xmind-open-view__thumb');
    assert.ok(img, '未渲染缩略图');
    assert.ok(img.src.startsWith('data:image/png;base64,'), img.src.slice(0, 40));
  });

  await check('解出的字节与档案内完全一致', async () => {
    const { view } = await open(thumbZip);
    const img = view.contentEl.querySelector('.xmind-open-view__thumb');
    const bytes = Buffer.from(img.src.split(',')[1], 'base64');
    assert.strictEqual(bytes.length, png12.length);
    assert.ok(bytes.equals(png12), '字节不一致');
  });

  await check('确实经由 vault.readBinary 读取', async () => {
    const { l } = await open(thumbZip);
    assert.deepStrictEqual(l.env.readBinaryCalls, [FILE]);
  });

  await check('有缩略图时不再渲染占位大图标', async () => {
    const { view } = await open(thumbZip);
    assert.strictEqual(view.contentEl.querySelector('.xmind-open-view__icon'), null);
  });

  await check('无缩略图条目时降级为图标，按钮仍在', async () => {
    const { view } = await open(noThumbZip);
    assert.strictEqual(view.contentEl.querySelector('.xmind-open-view__thumb'), null);
    assert.ok(view.contentEl.querySelector('.xmind-open-view__icon'), '缺少降级图标');
    assert.ok(view.contentEl.querySelector('.xmind-open-view__button'), '按钮应仍存在');
  });

  await check('档案损坏（非 zip）时降级且不抛异常', async () => {
    const { view } = await open(Buffer.alloc(64, 0x5a));
    assert.strictEqual(view.contentEl.querySelector('.xmind-open-view__thumb'), null);
    assert.ok(view.contentEl.querySelector('.xmind-open-view__button'));
  });

  await check('零字节档案也能安全降级', async () => {
    const { view } = await open(Buffer.alloc(0));
    assert.strictEqual(view.contentEl.querySelector('.xmind-open-view__thumb'), null);
  });

  await check('stored（未压缩）条目同样可读', async () => {
    const storedZip = makeZip([{ name: 'Thumbnails/thumbnail.png', data: png12, store: true }]);
    const { view } = await open(storedZip);
    const img = view.contentEl.querySelector('.xmind-open-view__thumb');
    assert.ok(img, 'stored 条目未被解出');
    assert.ok(Buffer.from(img.src.split(',')[1], 'base64').equals(png12));
  });

  await check('超过 4 MiB 的缩略图被跳过', async () => {
    const huge = makeZip([
      { name: 'Thumbnails/thumbnail.png', data: Buffer.alloc(5 * 1024 * 1024, 7) },
    ]);
    const { view } = await open(huge);
    assert.strictEqual(view.contentEl.querySelector('.xmind-open-view__thumb'), null);
  });

  await check('showThumbnail=false 时完全不读取文件', async () => {
    const { l, view } = await open(thumbZip, { showThumbnail: false });
    assert.deepStrictEqual(l.env.readBinaryCalls, []);
    assert.strictEqual(view.contentEl.querySelector('.xmind-open-view__thumb'), null);
  });

  await check('第二次打开命中缓存，不再读磁盘', async () => {
    const l = loadPlugin({ files: { [FILE]: thumbZip } });
    await l.plugin.onload();
    const file = l.app.vault.getAbstractFileByPath(FILE);
    await l.openFile(file);
    await tick(20);
    await l.openFile(file);
    await tick(20);
    assert.strictEqual(
      l.env.readBinaryCalls.length,
      1,
      '实际读取 ' + l.env.readBinaryCalls.length + ' 次'
    );
  });

  await check('切换文件后丢弃迟到的缩略图结果', async () => {
    // a's read is left in flight, then the view moves to a file with NO
    // preview. If the stale result were applied, an <img> would appear for a
    // file that has none — a difference the assertion can actually see
    // (an earlier version of this test compared two thumbnails and passed
    // either way, i.e. it proved nothing until mutation testing caught it).
    const withThumb = makeZip([{ name: 'Thumbnails/thumbnail.png', data: png12 }]);
    const withoutThumb = makeZip([{ name: 'content.json', data: '{}' }]);
    const l = loadPlugin({
      files: { 'a.xmind': withThumb, 'b.xmind': withoutThumb },
      readBinaryDelayByPath: { 'a.xmind': 60 },
    });
    await l.plugin.onload();
    const view = await l.openFile(l.app.vault.getAbstractFileByPath('a.xmind'));
    await view.setState({ file: 'b.xmind' });
    await tick(140);

    assert.strictEqual(
      view.contentEl.querySelector('.xmind-open-view__thumb'),
      null,
      '迟到的 a 缩略图污染了 b 的视图'
    );
    assert.ok(view.contentEl.querySelector('.xmind-open-view__icon'), '应显示降级图标');
  });

  await check('点击缩略图即触发系统打开', async () => {
    const calls = [];
    const { view } = await open(thumbZip, {}, {
      openWithDefaultApp: (p) => { calls.push(p); },
    });
    assert.deepStrictEqual(calls, [], '默认不应自动打开');
    view.contentEl.querySelector('.xmind-open-view__thumb').click();
    await tick(20);
    assert.deepStrictEqual(calls, [FILE]);
  });
}

async function sectionJ() {
  console.log('\n[J] 真实 .xmind 端到端');
  // A real archive is required for this one, so it is skipped when absent —
  // e.g. on CI, where the author's vault does not exist. Set XMO_SAMPLE to
  // point at one and it stops being skipped.
  const SAMPLE =
    process.env.XMO_SAMPLE || 'E:/tool/Obsidian/Note/main/学习/Tool/Houdini/Houdini.xmind';
  if (!fs.existsSync(SAMPLE)) {
    console.log('  (跳过：未提供真实 .xmind 样本 — 设 XMO_SAMPLE 可启用)');
    return;
  }

  const l = loadPlugin({ files: { 'Houdini.xmind': fs.readFileSync(SAMPLE) } });
  await l.plugin.onload();
  const view = await l.openFile(l.app.vault.getAbstractFileByPath('Houdini.xmind'));
  await tick(60);

  await check('真实档案解出的缩略图与 Python zipfile 逐字节一致', () => {
    const img = view.contentEl.querySelector('.xmind-open-view__thumb');
    assert.ok(img, '未渲染缩略图');
    const bytes = Buffer.from(img.src.split(',')[1], 'base64');
    assert.strictEqual(bytes.length, 269455);
    assert.strictEqual(bytes.slice(0, 4).toString('hex'), '89504e47');
    assert.strictEqual(
      crypto.createHash('sha256').update(bytes).digest('hex'),
      '0cd0ccfbade7974c815e830f9c5254ed9109d1a6b39583634b2e5904517494dd'
    );
  });
}

async function sectionK() {
  console.log('\n[K] XMind 程序路径（自定义 / 自动检测）');

  const FILE = 'map.xmind';
  const ABS = 'C:/vault/' + FILE;

  /** child_process stub: records spawns, answers `reg query` calls. */
  function cpStub(options) {
    const opts = options || {};
    const spawned = [];
    const queried = [];
    return {
      spawned,
      queried,
      api: {
        spawn(exe, args, spawnOpts) {
          spawned.push({ exe, args, opts: spawnOpts });
          const handlers = {};
          const child = {
            once(event, fn) {
              (handlers[event] = handlers[event] || []).push(fn);
              return child;
            },
            unref() { return child; },
            emit(event, arg) { (handlers[event] || []).forEach((fn) => fn(arg)); },
          };
          // Async on purpose: callers attach listeners *after* spawn() returns,
          // so a synchronous emit would be dropped.
          setTimeout(() => {
            if (opts.spawnError) child.emit('error', new Error(opts.spawnError));
            else child.emit('spawn');
          }, 0);
          return child;
        },
        execFile(cmd, args, execOpts, cb) {
          const key = args[1];
          queried.push(key);
          const answer = opts.registry && opts.registry[key];
          if (answer === undefined) return cb(new Error('not found'), '');
          cb(null, 'HKEY_CLASSES_ROOT\\' + key + '\r\n    (默认)    REG_SZ    ' + answer + '\r\n');
        },
      },
    };
  }

  /** Hide the built-in candidate list so "not found" is testable no matter
   *  what happens to be installed on this machine. Restored afterwards. */
  async function withoutCandidates(PluginClass, fn) {
    const list = PluginClass.__test.XMIND_CANDIDATES;
    const backup = list.splice(0, list.length);
    try {
      return await fn();
    } finally {
      list.push.apply(list, backup);
    }
  }

  // A real executable whose path contains a space: proves space handling
  // without mocking the existence check.
  const spaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmind open '));
  const spacedExe = path.join(spaceDir, 'X Mind.exe');
  fs.writeFileSync(spacedExe, '');

  try {
    await check('配置了路径时直接用该程序打开，参数为文件绝对路径', async () => {
      const cp = cpStub();
      const l = loadPlugin({
        files: { [FILE]: 'x' },
        data: { xmindPath: process.execPath },
        childProcess: cp.api,
      });
      await l.plugin.onload();
      const r = await l.plugin.openExternally(l.app.vault.getAbstractFileByPath(FILE));
      assert.strictEqual(r.ok, true, r.message);
      assert.strictEqual(cp.spawned.length, 1, '应只启动一次');
      assert.strictEqual(cp.spawned[0].exe, process.execPath);
      assert.deepStrictEqual(cp.spawned[0].args, [ABS]);
      assert.strictEqual(cp.spawned[0].opts.detached, true);
    });

    await check('路径含空格时作为单个参数传递，不被拆断', async () => {
      const cp = cpStub();
      const l = loadPlugin({
        files: { [FILE]: 'x' },
        data: { xmindPath: spacedExe },
        childProcess: cp.api,
      });
      await l.plugin.onload();
      const r = await l.plugin.openExternally(l.app.vault.getAbstractFileByPath(FILE));
      assert.strictEqual(r.ok, true, r.message);
      assert.strictEqual(cp.spawned[0].exe, spacedExe);
      assert.deepStrictEqual(cp.spawned[0].args, [ABS]);
    });

    await check('指定路径不存在时报错，且不回退到系统关联', async () => {
      const cp = cpStub();
      const fellBack = [];
      const l = loadPlugin({
        files: { [FILE]: 'x' },
        data: { xmindPath: 'C:/nope/XMind.exe' },
        childProcess: cp.api,
        openWithDefaultApp: (p) => { fellBack.push(p); },
      });
      await l.plugin.onload();
      const r = await l.plugin.openExternally(l.app.vault.getAbstractFileByPath(FILE));
      assert.strictEqual(r.ok, false);
      assert.match(r.message, /指定的程序不存在/);
      assert.match(r.message, /清空该路径/);
      assert.strictEqual(cp.spawned.length, 0, '不应尝试启动');
      assert.deepStrictEqual(fellBack, [], '不应静默回退');
    });

    await check('spawn 失败时返回失败原因', async () => {
      const cp = cpStub({ spawnError: 'EACCES: permission denied' });
      const l = loadPlugin({
        files: { [FILE]: 'x' },
        data: { xmindPath: process.execPath },
        childProcess: cp.api,
      });
      await l.plugin.onload();
      const r = await l.plugin.openExternally(l.app.vault.getAbstractFileByPath(FILE));
      assert.strictEqual(r.ok, false);
      assert.match(r.message, /EACCES/);
    });

    await check('未配置路径时仍走系统文件关联，不 spawn', async () => {
      const cp = cpStub();
      const calls = [];
      const l = loadPlugin({
        files: { [FILE]: 'x' },
        childProcess: cp.api,
        openWithDefaultApp: (p) => { calls.push(p); },
      });
      await l.plugin.onload();
      const r = await l.plugin.openExternally(l.app.vault.getAbstractFileByPath(FILE));
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(calls, [FILE]);
      assert.strictEqual(cp.spawned.length, 0);
    });

    // --- pure helpers ----------------------------------------------------
    const { PluginClass: KClass } = loadPlugin({});
    const { extractExecutable, expandEnv } = KClass.__test;

    await check('extractExecutable 解析各种命令行形式', () => {
      assert.strictEqual(
        extractExecutable('"C:\\Program Files\\XMind\\XMind.exe" "%1"'),
        'C:\\Program Files\\XMind\\XMind.exe'
      );
      assert.strictEqual(extractExecutable('C:\\XMind\\XMind.exe %1'), 'C:\\XMind\\XMind.exe');
      assert.strictEqual(extractExecutable(''), null);
      assert.strictEqual(extractExecutable(null), null);
      assert.strictEqual(extractExecutable('some-other-command'), null);
    });

    await check('expandEnv 展开 %VAR%，未知变量原样保留', () => {
      process.env.__XMO_PROBE__ = 'C:\\fake';
      assert.strictEqual(expandEnv('%__XMO_PROBE__%\\XMind.exe'), 'C:\\fake\\XMind.exe');
      assert.strictEqual(expandEnv('%__XMO_NOT_SET__%\\a'), '%__XMO_NOT_SET__%\\a');
      delete process.env.__XMO_PROBE__;
    });

    await check('检测：系统关联命中时返回该程序', async () => {
      const cp = cpStub({
        registry: {
          'HKCR\\.xmind': 'XMind.File',
          'HKCR\\XMind.File\\shell\\open\\command': '"' + process.execPath + '" "%1"',
        },
      });
      const l = loadPlugin({ childProcess: cp.api });
      const found = await l.PluginClass.__test.detectXmindExecutable();
      assert.ok(found, '未检测到');
      assert.strictEqual(found.path, process.execPath);
      assert.strictEqual(found.source, '系统文件关联');
      assert.deepStrictEqual(cp.queried, [
        'HKCR\\.xmind',
        'HKCR\\XMind.File\\shell\\open\\command',
      ]);
    });

    await check('检测：关联指向不存在的程序时被存在性检查否掉', async () => {
      const cp = cpStub({
        registry: {
          'HKCR\\.xmind': 'XMind.File',
          'HKCR\\XMind.File\\shell\\open\\command': '"C:\\Ghost\\XMind.exe" "%1"',
        },
      });
      const l = loadPlugin({ childProcess: cp.api });
      const found = await withoutCandidates(l.PluginClass, () =>
        l.PluginClass.__test.detectXmindExecutable()
      );
      assert.strictEqual(found, null, '幽灵路径不应被采纳');
    });

    await check('检测：完全没有 XMind 时返回 null', async () => {
      const cp = cpStub({ registry: {} });
      const l = loadPlugin({ childProcess: cp.api });
      const found = await withoutCandidates(l.PluginClass, () =>
        l.PluginClass.__test.detectXmindExecutable()
      );
      assert.strictEqual(found, null);
    });

    await check('检测：关联缺失时回落到常见安装位置', async () => {
      const cp = cpStub({ registry: {} });
      const l = loadPlugin({ childProcess: cp.api });
      await withoutCandidates(l.PluginClass, async () => {
        l.PluginClass.__test.XMIND_CANDIDATES.push(spacedExe, 'C:\\nope\\XMind.exe');
        const found = await l.PluginClass.__test.detectXmindExecutable();
        assert.ok(found, '未检测到候选路径');
        assert.strictEqual(found.source, '常见安装位置');
        assert.strictEqual(found.path, spacedExe);
      });
    });

    // --- settings UI -----------------------------------------------------
    await check('点击「自动检测」写入设置、data.json 与文本框', async () => {
      const cp = cpStub({
        registry: {
          'HKCR\\.xmind': 'XMind.File',
          'HKCR\\XMind.File\\shell\\open\\command': '"' + process.execPath + '" "%1"',
        },
      });
      const l = loadPlugin({ childProcess: cp.api });
      await l.plugin.onload();
      const tab = l.env.settingTabs[0];
      tab.display();
      const target = l.env.settingComponents.find((s) => s.buttons.length);
      assert.ok(target, '未找到带按钮的设置项');
      assert.strictEqual(target.name, 'XMind 程序路径（一般留空）');

      await target.buttons[0].clickCb();

      assert.strictEqual(l.plugin.settings.xmindPath, process.execPath);
      assert.strictEqual(l.env.saved.xmindPath, process.execPath);
      assert.strictEqual(target.texts[0].value, process.execPath, '文本框应同步');
      const result = tab.containerEl.querySelector('.xmind-open-detect-result');
      assert.match(result.textContent, /已检测到/);
      assert.ok(result.className.includes('is-ok'), result.className);
    });

    await check('检测不到时给出可操作的失败提示', async () => {
      const cp = cpStub({ registry: {} });
      const l = loadPlugin({ childProcess: cp.api });
      await l.plugin.onload();
      await withoutCandidates(l.PluginClass, async () => {
        const tab = l.env.settingTabs[0];
        tab.display();
        const target = l.env.settingComponents.find((s) => s.buttons.length);
        await target.buttons[0].clickCb();
        const result = tab.containerEl.querySelector('.xmind-open-detect-result');
        assert.match(result.textContent, /未检测到/);
        assert.match(result.textContent, /手动填写/);
        assert.ok(result.className.includes('is-error'), result.className);
      });
    });
  } finally {
    fs.rmSync(spaceDir, { recursive: true, force: true });
  }
}

async function sectionL() {
  console.log('\n[L] 语言 / i18n');

  const FILE = 'map.xmind';
  const EN_BUTTON = 'Open with system default app';
  const ZH_BUTTON = '用系统默认程序打开';

  const openWith = async (locale) => {
    const l = loadPlugin({ locale, files: { [FILE]: 'x' } });
    await l.plugin.onload();
    const view = await l.openFile(l.app.vault.getAbstractFileByPath(FILE));
    return { l, view };
  };

  await check('英文环境：视图按钮与说明为英文', async () => {
    const { view } = await openWith('en');
    assert.strictEqual(
      view.contentEl.querySelector('.xmind-open-view__button').textContent,
      EN_BUTTON
    );
    assert.match(view.contentEl.querySelector('.xmind-open-view__hint').textContent, /never parsed/);
  });

  await check('英文环境：状态消息为英文', async () => {
    const l = loadPlugin({
      locale: 'en',
      files: { [FILE]: 'x' },
      openWithDefaultApp: () => {},
    });
    await l.plugin.onload();
    const view = await l.openFile(l.app.vault.getAbstractFileByPath(FILE));
    await view.openExternal();
    const status = view.contentEl.querySelector('.xmind-open-view__status');
    assert.strictEqual(status.textContent, 'Handed off to the system default app');
  });

  await check('英文环境：设置面板标题与开关名称为英文', async () => {
    const l = loadPlugin({ locale: 'en' });
    await l.plugin.onload();
    const tab = l.env.settingTabs[0];
    tab.display();
    assert.strictEqual(tab.containerEl.querySelector('h2').textContent, 'XMind Open settings');
    const toggles = l.env.settingComponents.filter((s) => s.toggles.length);
    assert.strictEqual(toggles[0].name, 'Open with the system app automatically');
    assert.strictEqual(toggles[1].name, 'Show preview image');
  });

  await check('英文环境：右键菜单标题为英文', async () => {
    const l = loadPlugin({ locale: 'en', files: { 'a.xmind': 'x' } });
    await l.plugin.onload();
    const menu = makeMenu();
    l.menuHandlers.forEach((h) => h(menu, l.app.vault.getAbstractFileByPath('a.xmind')));
    assert.strictEqual(menu.items[0].title, EN_BUTTON);
  });

  await check('中文环境：视图按钮为中文（作者日常使用）', async () => {
    const { view } = await openWith('zh');
    assert.strictEqual(
      view.contentEl.querySelector('.xmind-open-view__button').textContent,
      ZH_BUTTON
    );
  });

  await check('zh-TW / zh-Hans 等变体也识别为中文', async () => {
    for (const variant of ['zh-TW', 'zh-Hans', 'zh-CN']) {
      const { view } = await openWith(variant);
      assert.strictEqual(
        view.contentEl.querySelector('.xmind-open-view__button').textContent,
        ZH_BUTTON,
        variant + ' 未识别为中文'
      );
    }
  });

  await check('未知语言回落到英文（发布版默认）', async () => {
    const { view } = await openWith('fr');
    assert.strictEqual(
      view.contentEl.querySelector('.xmind-open-view__button').textContent,
      EN_BUTTON
    );
  });

  await check('无 localStorage 语言设置时回落到 navigator，不崩溃', async () => {
    const { view } = await openWith(null);
    // jsdom 的 window.navigator.language 是 en-US ⇒ 英文
    assert.strictEqual(
      view.contentEl.querySelector('.xmind-open-view__button').textContent,
      EN_BUTTON
    );
  });

  await check('两套语言的键集合完全一致（防止漏翻）', () => {
    const { STRINGS } = loadPlugin({}).PluginClass.__test;
    const en = Object.keys(STRINGS.en).sort();
    const zh = Object.keys(STRINGS.zh).sort();
    assert.deepStrictEqual(zh, en, '键集合不一致');
    assert.ok(en.length >= 25, '键数量异常：' + en.length);
  });

  await check('同名键在两套语言中的类型一致（函数/字符串不能混）', () => {
    const { STRINGS } = loadPlugin({}).PluginClass.__test;
    for (const key of Object.keys(STRINGS.en)) {
      assert.strictEqual(
        typeof STRINGS.zh[key],
        typeof STRINGS.en[key],
        '键 "' + key + '" 类型不一致'
      );
    }
  });

  await check('所有语言值都非空', () => {
    const { STRINGS } = loadPlugin({}).PluginClass.__test;
    for (const lang of Object.keys(STRINGS)) {
      for (const [key, value] of Object.entries(STRINGS[lang])) {
        if (typeof value === 'function') continue;
        assert.ok(String(value).trim().length > 0, lang + '.' + key + ' 为空');
      }
    }
  });
}

(async () => {
  console.log('xmind-open offline test suite');
  console.log('main: ' + MAIN_PATH);

  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();
  await sectionF();
  await sectionG();
  await sectionH();
  await sectionI();
  await sectionJ();
  await sectionK();
  await sectionL();

  console.log('\n' + '='.repeat(52));
  console.log('passed: ' + pass + '   failed: ' + fail);
  process.exit(fail > 0 ? 1 : 0);
})();
