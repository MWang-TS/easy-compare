/* 大目录性能验证：造 16800 个文件 / 120 个顶层目录的树，验证
   1) 虚拟滚动生效：DOM 中只保留一屏多一点的行；
   2) 首屏、折叠、全部展开/收起、切换筛选、搜索都在可接受时间内；
   3) 滚到底部仍能绘制到最后一个节点。
   用法：node scripts/verify_perf.cjs */
const path = require('path');
const fs = require('fs');

function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.workbuddy/skills/stageshow/node_modules/playwright-core') : null,
    'playwright-core',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c).chromium; } catch (e) { /* next */ }
  }
  throw new Error('未找到 playwright-core');
}
const chromium = loadChromium();
const URL = 'file:///' + path.resolve(__dirname, '../src/index.html').replace(/\\/g, '/');

const DIRS = 120, PER_DIR = 140;          // 16800 个文件
const MAX_FIRST_PAINT = 1500;              // ms
const MAX_INTERACTION = 600;               // ms
const MAX_DOM_ROWS = 160;

function buildTree() {
  const roots = [];
  for (let d = 0; d < DIRS; d++) {
    const name = `dir-${String(d).padStart(3, '0')}`;
    const children = [];
    for (let f = 0; f < PER_DIR; f++) {
      const rel = `${name}/file-${f}.txt`;
      const state = f % 7 === 0 ? 'ok' : (f % 5 === 0 ? 'diff' : 'left');
      children.push({
        id: rel, rel, name: `file-${f}.txt`, kind: 'file', state,
        l: '1 KB', r: state === 'ok' ? '1 KB' : '', lb: 1024, rb: state === 'ok' ? 1024 : 0,
        lt: state === 'ok' ? '已同步' : '待新增', rt: state === 'ok' ? '已同步' : '缺失',
        nw: '', err: '', hasL: true, hasR: state === 'ok', children: [],
      });
    }
    roots.push({
      id: name, rel: name, name, kind: 'dir', state: 'left',
      l: '', r: '', lb: 0, rb: 0, lt: '', rt: '', nw: '', err: '',
      hasL: true, hasR: false, children,
    });
  }
  return roots;
}

const RESULT = {
  sessionId: 'perf', sourcePath: 'D:\\src', targetPath: 'D:\\tgt', tree: buildTree(),
  counts: { ok: 2400, diff: 3360, left: 11040, right: 0, conflict: 0, unknown: 0, total: 16800 },
  comparedAt: Math.floor(Date.now() / 1000), hasBaseline: false, volumeOk: true,
  volumeMessage: 'ok', compareRule: 'quick', warnings: [], scannedFiles: 16800, skippedLinks: 0, aborted: false,
};

(async () => {
  const launchOpts = { headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] };
  const exe = process.env.CHROME_BIN ||
    'C:/Users/wangm/AppData/Local/ms-playwright/chromium_headless_shell-1161/chrome-win/headless_shell.exe';
  if (exe && fs.existsSync(exe)) launchOpts.executablePath = exe;
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.addInitScript((result) => {
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        if (cmd === 'compare' || cmd === 'refresh_after_backup') return JSON.parse(JSON.stringify(result));
        if (cmd === 'active_session') return {
          id: 'perf', name: '性能验证', sourcePath: result.sourcePath, targetPath: result.targetPath,
          targetVolume: 'X', compareRule: 'quick', filters: {}, lastBackupAt: null, createdAt: 0, updatedAt: 0,
        };
        if (cmd === 'list_sessions' || cmd === 'list_drives') return [];
        return null;
      },
    };
    window.__TAURI__ = { event: { listen: async () => () => {} } };
  }, RESULT);

  const log = [];
  const ok = (name, cond, extra) => {
    const line = (cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : '');
    log.push(line); console.log(line);
  };
  const timed = async (fn) => {
    const t = Date.now();
    await fn();
    await page.waitForTimeout(60);
    return Date.now() - t;
  };

  await page.goto(URL, { waitUntil: 'load' });
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelectorAll('#tree .row').length > 0, null, { timeout: 20000 });
  const first = Date.now() - t0;
  ok('首屏渲染耗时', first < MAX_FIRST_PAINT, first + ' ms');

  const domRows = await page.locator('#tree .row').count();
  ok('虚拟滚动生效（DOM 行数受控）', domRows <= MAX_DOM_ROWS, `DOM=${domRows} 总行=16800`);

  // 默认只展开第一层；这棵树的所有目录都是顶层，所以「展开全部」初始即为禁用态。
  // 先「收起全部」再「展开全部」，把两个方向都量到。
  ok('全展开时「展开全部」置灰', (await page.locator('#expandAll').getAttribute('aria-disabled')) === 'true');
  const tCollapse = await timed(() => page.locator('#collapseAll').click());
  ok('全部收起耗时', tCollapse < MAX_INTERACTION, tCollapse + ' ms');
  const tExpand = await timed(() => page.locator('#expandAll').click());
  ok('全部展开耗时', tExpand < MAX_INTERACTION, tExpand + ' ms');
  ok('展开后 DOM 行数仍受控', (await page.locator('#tree .row').count()) <= MAX_DOM_ROWS);

  const tFold = await timed(() => page.locator('#tree .row[data-row]').first().locator('.fold').first().click());
  ok('折叠单个目录耗时', tFold < MAX_INTERACTION, tFold + ' ms');

  const tDiff = await timed(() => page.locator('#onlyDiff').click());
  ok('切换「只看差异」耗时', tDiff < MAX_INTERACTION, tDiff + ' ms');

  const tSearch = await timed(() => page.locator('#searchInput').fill('file-13'));
  ok('搜索耗时', tSearch < MAX_INTERACTION, tSearch + ' ms');

  // 滚到底部：虚拟滚动必须能绘制到最后一个可见节点
  await page.locator('#tree').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  const lastText = await page.locator('#tree .row').last().textContent();
  ok('滚动到底部仍能绘制尾部行', !!lastText && lastText.trim().length > 0, lastText.trim().slice(0, 40));
  ok('控制台零报错', errors.length === 0, errors.slice(0, 3).join(' / '));

  const failed = log.filter((x) => x.startsWith('FAIL'));
  console.log('\nSUMMARY: ' + (log.length - failed.length) + '/' + log.length + ' passed');
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('VERIFY_CRASH', e); process.exit(2); });
