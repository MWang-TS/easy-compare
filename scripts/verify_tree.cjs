/* 双栏结构验证：用「真实扫描形状」的合成数据（含仅目标端存在的目录）验证
   1) 目录折叠按钮在左右两栏都存在、尺寸足够、且两栏同步；
   2) 缺失侧不再显示长段 ghost 文案，只显示「—」；
   3) 单侧目录的状态标签方向正确（缺失 / 全部保留）。
   用法：node scripts/verify_tree.cjs */
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
const OUT = path.resolve(__dirname, '../.verify');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const file = (rel, name, state, extra) => Object.assign({
  id: rel, rel, name, kind: 'file', state, l: '', r: '', lb: 0, rb: 0,
  lt: '', rt: '', nw: '', err: '', hasL: false, hasR: false, children: [],
}, extra || {});
const dir = (rel, name, state, hasL, hasR, children) => ({
  id: rel, rel, name, kind: 'dir', state, l: '', r: '', lb: 0, rb: 0,
  lt: '', rt: '', nw: '', err: '', hasL, hasR, children,
});

const TREE = [
  dir('.metadata', '.metadata', 'right', false, true, [
    file('.metadata/.dir_list.all.name.ascent', '.dir_list.all.name.ascent', 'right', { hasR: true, rb: 530, r: '530 B', rt: '默认保留' }),
    file('.metadata/.file_list.document.name.ascent', '.file_list.document.name.ascent', 'right', { hasR: true, rb: 90, r: '90 B', rt: '默认保留' }),
  ], { lt: '缺失', rt: '全部保留' }),
  dir('Announcements', 'Announcements', 'right', false, true, [
    dir('Announcements/.metadata', '.metadata', 'right', false, true, [
      file('Announcements/.metadata/a.ascent', 'a.ascent', 'right', { hasR: true, rb: 254, r: '254 B', rt: '默认保留' }),
    ], { lt: '缺失', rt: '全部保留' }),
  ], { lt: '缺失', rt: '全部保留' }),
  dir('仅源有目录', '仅源有目录', 'left', true, false, [
    file('仅源有目录/notes.md', 'notes.md', 'left', { hasL: true, lb: 1024, l: '1 KB', lt: '待新增' }),
  ], { lt: '待新增', rt: '缺失' }),
  file('README.md', 'README.md', 'ok', { hasL: true, hasR: true, lb: 4096, rb: 4096, l: '4 KB', r: '4 KB', lt: '已同步', rt: '已同步' }),
];

const RESULT = {
  sessionId: 'tree', sourcePath: 'D:\\src', targetPath: 'D:\\tgt', tree: TREE,
  counts: { ok: 1, diff: 0, left: 1, right: 4, conflict: 0, unknown: 0, total: 6 },
  comparedAt: Math.floor(Date.now() / 1000), hasBaseline: false, volumeOk: true,
  volumeMessage: 'ok', compareRule: 'quick', warnings: [], scannedFiles: 6, skippedLinks: 0, aborted: false,
};

(async () => {
  const launchOpts = { headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] };
  const exe = process.env.CHROME_BIN ||
    'C:/Users/wangm/AppData/Local/ms-playwright/chromium_headless_shell-1161/chrome-win/headless_shell.exe';
  if (exe && fs.existsSync(exe)) launchOpts.executablePath = exe;
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.addInitScript((result) => {
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        if (cmd === 'compare' || cmd === 'refresh_after_backup' || cmd === 'verify_hashes') return JSON.parse(JSON.stringify(result));
        if (cmd === 'active_session') return {
          id: 'tree', name: '结构验证', sourcePath: result.sourcePath, targetPath: result.targetPath,
          targetVolume: 'X', compareRule: 'quick', filters: {}, lastBackupAt: null, createdAt: 0, updatedAt: 0,
        };
        if (cmd === 'list_drives' || cmd === 'list_sessions') return [];
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

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#tree .row').length > 0, null, { timeout: 10000 });

  // 1. 折叠按钮在左右两栏都存在（即使该侧没有这个目录）
  const foldCounts = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree .row[data-row]')];
    return rows.map((r) => ({
      id: r.dataset.row,
      folds: [...r.querySelectorAll('.fold[data-exp]')].length,
      boxes: [...r.querySelectorAll('.fold[data-exp]')].map((f) => {
        const b = f.getBoundingClientRect();
        return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
      }),
    }));
  });
  ok('每个目录行都有左右两个折叠按钮', foldCounts.every((f) => f.folds === 2),
    foldCounts.map((f) => f.id + ':' + f.folds).join(' '));
  ok('折叠按钮尺寸足够（≥16px）', foldCounts.every((f) => f.boxes.every((b) => b[2] >= 16 && b[3] >= 16)),
    JSON.stringify(foldCounts[0] && foldCounts[0].boxes));
  ok('左右两栏折叠按钮纵向位置一致', foldCounts.every((f) => f.boxes.length === 2 && f.boxes[0][1] === f.boxes[1][1]));

  // 2. 缺失侧只显示「—」
  const metaRow = page.locator('#tree .row[data-row=".metadata"]');
  // 用首/尾 cell 定位左右栏，不写死列序号，避免后续加列时测试失效
  const leftCell = metaRow.locator('.cell').first();
  const rightCell = metaRow.locator('.cell').last();
  const leftText = (await leftCell.textContent()).trim();
  const rightText = (await rightCell.textContent()).trim();
  ok('缺失侧显示短横线而不是长段说明', leftText.includes('—') && !leftText.includes('源端已无对应项'), leftText);
  ok('缺失侧状态标签为「缺失」', leftText.includes('缺失'), leftText);
  ok('目标端独有的目录右栏标注「全部保留」', rightText.includes('全部保留'), rightText);
  const onlySrc = page.locator('#tree .row[data-row="仅源有目录"]');
  ok('仅源有的目录左栏标注「待新增」', (await onlySrc.locator('.cell').first().textContent()).includes('待新增'));

  // 2b. 列头为四列：源 / 状态 / 复制 / 目标
  const headCols = await page.locator('.colhead > div').evaluateAll((els) => els.map((e) => ({ text: e.textContent.trim().replace(/\s+/g, ' '), title: e.getAttribute('title') || '' })));
  ok('列头包含「复制」操作列且位于状态列右侧',
    headCols.length === 4 && headCols[1].text.includes('状态') && headCols[2].title.includes('复制') && headCols[3].text.includes('目标'),
    headCols.map((c) => c.text || c.title).join(' | '));
  ok('复制列表头用图标（无文字）', headCols[2].text === '' && (await page.locator('.colhead .act svg').count()) === 1);
  const cellCounts = await page.evaluate(() => [...document.querySelectorAll('#tree .row')].map((r) => r.children.length));
  ok('每行与列头列数一致（4 列）', cellCounts.every((n) => n === 4), [...new Set(cellCounts)].join(','));

  // 3. 折叠同步（点右栏按钮，两栏按钮状态同时变化）
  const opensOf = (id) => page.evaluate((key) => [...document.querySelectorAll(`#tree .row[data-row]`)].find((r) => r.dataset.row === key)
    .querySelectorAll('.fold[data-exp]'), id).then;
  const foldStates = async (id) => page.evaluate((key) => {
    const row = [...document.querySelectorAll('#tree .row[data-row]')].find((r) => r.dataset.row === key);
    return [...row.querySelectorAll('.fold[data-exp]')].map((f) => (f.classList.contains('open') ? 'open' : 'closed'));
  }, id);
  ok('初始两侧均为展开', (await foldStates('.metadata')).join(',') === 'open,open');
  const rowsBefore = await page.locator('#tree .row').count();
  await metaRow.locator('.fold[data-exp]').last().click();
  await page.waitForTimeout(150);
  ok('从右栏点击折叠后两栏同步为收起', (await foldStates('.metadata')).join(',') === 'closed,closed');
  const rowsAfter = await page.locator('#tree .row').count();
  ok('折叠后该目录的 2 个子项不再渲染', rowsAfter === rowsBefore - 2, rowsBefore + ' -> ' + rowsAfter);
  await page.screenshot({ path: path.join(OUT, 'tree-folded.png') });
  await metaRow.locator('.fold[data-exp]').first().click();
  await page.waitForTimeout(150);
  ok('从左栏点击展开后两栏同步为展开', (await foldStates('.metadata')).join(',') === 'open,open');

  ok('控制台零报错', errors.length === 0, errors.slice(0, 3).join(' / '));

  const failed = log.filter((x) => x.startsWith('FAIL'));
  console.log('\nSUMMARY: ' + (log.length - failed.length) + '/' + log.length + ' passed');
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('VERIFY_CRASH', e); process.exit(2); });
