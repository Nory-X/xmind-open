'use strict';

/**
 * Mutation testing for the `xmind-open` suite.
 *
 * Each mutant deliberately breaks one behaviour; the full suite is then run
 * against it and MUST fail. A mutant that survives means the corresponding
 * tests are green by accident (false green) and prove nothing.
 *
 * Anchors are asserted to match exactly once — a silently-missed anchor would
 * otherwise turn the whole exercise into theatre.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NODE = process.execPath;
// Relative to tests/, so this works from any checkout (including CI).
const MAIN = path.join(__dirname, '..', 'main.js');
const TMP = path.join(__dirname, '_mutants');
const SUITE = path.join(__dirname, 'run-tests.js');

const MUTANTS = [
  {
    name: '无视 autoOpen 设置，总是自动打开',
    expect: '[F] autoOpen=false 时不自动打开',
    from: 'if (this.plugin.settings.autoOpen) await this.openExternal();',
    to: 'if (true) await this.openExternal();',
  },
  {
    name: '右键菜单只对 .md 生效',
    expect: '[G] .xmind 加入菜单项',
    from: "if (!(file instanceof TFile) || file.extension !== XMIND_EXT) return;",
    to: "if (!(file instanceof TFile) || file.extension !== 'md') return;",
  },
  {
    name: 'resolveAbsolutePath 忽略 getFullPath',
    expect: '[A] getFullPath 优先于 basePath',
    from: "if (adapter && typeof adapter.getFullPath === 'function') {",
    to: 'if (false) {',
  },
  {
    name: '扩展名冲突时不降级（状态标错）',
    expect: '[B] extensionsRegistered = true',
    from: '      this.extensionsRegistered = true;',
    to: '      this.extensionsRegistered = false;',
  },
  {
    name: '按钮文案写错',
    expect: '[D] 渲染打开按钮',
    from: "const button = add('button', 'mod-cta xmind-open-view__button', t.openButton);",
    to: "const button = add('button', 'mod-cta xmind-open-view__button', 'Open');",
  },
  {
    name: '语言检测恒返回英文',
    expect: '[H] 两个开关的名称与初值都正确（中文界面断言）',
    from:
      "    const stored = window.localStorage.getItem('language');\n" +
      "    if (stored) return String(stored).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';",
    to: "    return 'en';",
  },
  {
    name: 'render 不再清空旧节点',
    expect: '[D] 重复渲染不累积节点',
    from: '    const root = this.contentEl;\n    clearEl(root);\n    root.classList.add(\'xmind-open-view\');',
    to: '    const root = this.contentEl;\n    root.classList.add(\'xmind-open-view\');',
  },
  {
    name: 'shell 回退时误用 vault 相对路径',
    expect: '[E] 回退 shell（绝对路径）',
    // Needs the trailing context: `resolveAbsolutePath` is now called from two
    // branches, and an ambiguous anchor would silently mutate the wrong one.
    from:
      '    const absolute = resolveAbsolutePath(this.app, file);\n' +
      '    if (!absolute) return { ok: false, message: t.unresolvedPath };\n' +
      '\n' +
      '    const failure = await shell.openPath(absolute);',
    to:
      '    const absolute = file.path;\n' +
      '    if (!absolute) return { ok: false, message: t.unresolvedPath };\n' +
      '\n' +
      '    const failure = await shell.openPath(absolute);',
  },
  // --- thumbnail preview -------------------------------------------------
  {
    name: '缩略图大小上限失效',
    expect: '[I] 超过 4 MiB 的缩略图被跳过',
    from: 'if (png && png.byteLength > 0 && png.byteLength <= MAX_THUMBNAIL_BYTES) {',
    to: 'if (png && png.byteLength > 0) {',
  },
  {
    name: 'deflate 条目不做解压，直接当结果返回',
    expect: '[I] 解出的字节与档案内完全一致',
    from: '    return new Uint8Array(zlib.inflateRawSync(raw));',
    to: '    return raw;',
  },
  {
    name: '中央目录偏移读错字段（拿成目录大小）',
    expect: '[I] 解出的字节与档案内完全一致',
    from: 'const cdOffset = view.getUint32(eocd + 16, true);',
    to: 'const cdOffset = view.getUint32(eocd + 12, true);',
  },
  {
    name: '不比对条目名，拿第一个条目就返回',
    expect: '[I] 无缩略图条目时降级为图标',
    from: 'if (name === wantedName) {',
    to: 'if (true) {',
  },
  {
    name: '忽略 showThumbnail 设置，总是加载',
    expect: '[I] showThumbnail=false 时完全不读取文件',
    from: 'if (this.plugin.settings.showThumbnail) this.refreshThumbnail();',
    to: 'this.refreshThumbnail();',
  },
  {
    name: '缓存查找被移除',
    expect: '[I] 第二次打开命中缓存，不再读磁盘',
    from: '  if (thumbnailCache.has(key)) return thumbnailCache.get(key);',
    to: '  if (false) return null;',
  },
  {
    name: '异步竞态守卫被移除',
    expect: '[I] 切换文件后丢弃迟到的缩略图结果',
    from: '    if (this.file !== file) return;',
    to: '    if (false) return;',
  },
  // --- custom executable path --------------------------------------------
  {
    name: '忽略设置里的 XMind 路径，始终走系统关联',
    expect: '[K] 配置了路径时直接用该程序打开',
    from: '    if (configured) {',
    to: '    if (false) {',
  },
  {
    name: '不校验指定程序是否存在，直接尝试启动',
    expect: '[K] 指定路径不存在时报错',
    from:
      '    if (!fileExists(exe)) {\n' +
      '      return resolve({ ok: false, message: t.executableMissing(exe) });\n' +
      '    }',
    to: "    if (false) {\n      return resolve({ ok: false, message: 'skipped' });\n    }",
  },
  {
    name: 'extractExecutable 不再取引号内的路径',
    expect: '[K] extractExecutable 解析各种命令行形式',
    from: '  const quoted = String(command).match(/"([^"]+\\.exe)"/i);',
    to: '  const quoted = null;',
  },
  {
    name: '检测时不校验候选程序是否真实存在',
    expect: '[K] 关联指向不存在的程序时被存在性检查否掉',
    from: '    if (exe && fileExists(exe)) return { path: exe, source: t.sourceAssociation };',
    to: '    if (exe) return { path: exe, source: t.sourceAssociation };',
  },
  {
    name: '检测按钮不把结果写回设置',
    expect: '[K] 点击「自动检测」写入设置',
    from:
      '          this.plugin.settings.xmindPath = found.path;\n' +
      '          await this.plugin.saveSettings();',
    to: '          // mutation: state intentionally left unchanged',
  },
];

function main() {
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

  const source = fs.readFileSync(MAIN, 'utf8');
  let killed = 0;
  let survived = 0;
  let broken = 0;

  console.log('xmind-open mutation testing');
  console.log('target: ' + MAIN + '\n');

  MUTANTS.forEach((mutant, index) => {
    const hits = source.split(mutant.from).length - 1;
    if (hits !== 1) {
      broken++;
      console.log('  !! 锚点失效  ' + mutant.name);
      console.log('     命中 ' + hits + ' 次（应为 1），期望捕获: ' + mutant.expect);
      return;
    }

    const file = path.join(TMP, 'mutant-' + index + '.js');
    fs.writeFileSync(file, source.replace(mutant.from, mutant.to));

    const run = spawnSync(NODE, [SUITE], {
      env: Object.assign({}, process.env, { XMO_MAIN: file }),
      encoding: 'utf8',
    });

    const failLines = (run.stdout || '').match(/^ {2}FAIL {2}.*$/gm) || [];

    if (run.status !== 0 && failLines.length > 0) {
      killed++;
      console.log('  ok  杀死  ' + mutant.name);
      console.log('       触发 ' + failLines.length + ' 项失败，例如: ' + failLines[0].trim().replace(/^FAIL {2}/, ''));
    } else if (run.status !== 0) {
      broken++;
      console.log('  ??  崩溃  ' + mutant.name + '（非断言失败，检查锚点是否改坏了语法）');
      console.log((run.stderr || '').split('\n').slice(0, 3).join('\n'));
    } else {
      survived++;
      console.log('  BAD 存活  ' + mutant.name);
      console.log('       测试全绿，说明 ' + mutant.expect + ' 并未真正覆盖该行为');
    }
  });

  console.log('\n' + '='.repeat(52));
  console.log(
    'killed: ' + killed + '   survived: ' + survived + '   anchor-issues: ' + broken +
    '   (total ' + MUTANTS.length + ')'
  );
  process.exit(survived === 0 && broken === 0 ? 0 : 1);
}

main();
