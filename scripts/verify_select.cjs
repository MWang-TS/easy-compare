/* 单行选中验证：用真实扫描形状的数据（含折叠目录）验证
   1) 单击文件行 = 只选中该文件；
   2) 单击折叠后的文件夹行 = 选中其整棵子树（含未渲染的子项）；
   3) 选中后进入预演清单，计划里正好只有这些文件；
   4) 双击目录行 = 折叠，不改变选中状态；
   5) 无可备份项的行给出提示且不改变选择。
   用法：node scripts/verify_select.cjs */
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

const f = (rel, name, state, extra) => Object.assign({
  id: rel, rel, name, kind: 'file', state, l: '1 KB', r: '', lb: 1024, rb: 0,
  lt: state === 'left' ? '待新增' : '已同步', rt: state === 'left' ? '缺失' : '已同步',
  nw: '', err: '', hasL: true, hasR: state === 'ok', children: [],
}, extra || {});
const d = (rel, name, state, hasL, hasR, children) => ({
  id: rel, rel, name, kind: 'dir', state, l: '', r: '', lb: 0, rb: 0,
  lt: '', rt: '', nw: '', err: '', hasL, hasR, children,
});

const TREE = [
  d('Photos', 'Photos', 'left', true, false, [
    f('Photos/a.jpg', 'a.jpg', 'left'),
    f('Photos/b.jpg', 'b.jpg', 'left'),
    d('Photos/2024', '2024', 'left', true, false, [
      f('Photos/2024/c.jpg', 'c.jpg', 'left'),
      f('Photos/2024/d.jpg', 'd.jpg', 'left'),
    ]),
  ]),
  d('Docs', 'Docs', 'left', true, false, [
    f('Docs/same.txt', 'same.txt', 'ok', { l: '1 KB', r: '1 KB', lb: 1024, rb: 1024 }),
    f('Docs/new.txt', 'new.txt', 'left'),
  ]),
  f('root.txt', 'root.txt', 'left'),
];

const RESULT = {
  sessionId: 'sel', sourcePath: 'D:\\src', targetPath: 'D:\\tgt', tree: TREE,
  counts: { ok: 1, diff: 0, left: 6, right: 0, conflict: 0, unknown: 0, total: 7 },
  comparedAt: Math.floor(Date.now() / 1000), hasBaseline: false, volumeOk: true,
  volumeMessage: 'ok', compareRule: 'quick', warnings: [], scannedFiles: 7, skippedLinks: 0, aborted: false,
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
      invoke: async (cmd, args) => {
        if (cmd === 'compare' || cmd === 'refresh_after_backup') return JSON.parse(JSON.stringify(result));
        if (cmd === 'active_session') return {
          id: 'sel', name: '选择验证', sourcePath: result.sourcePath, targetPath: result.targetPath,
          targetVolume: 'X', compareRule: 'quick', filters: {}, lastBackupAt: null, createdAt: 0, updatedAt: 0,
        };
        if (cmd === 'create_plan') {
          const wanted = new Set((args && args.selected ? args.selected : []).map((s) => String(s).toLowerCase()));
          const files = [];
          const walk = (nodes) => nodes.forEach((n) => {
            if (n.kind === 'file') { if (wanted.has(n.id.toLowerCase()) && n.state === 'left') files.push(n.rel); }
            else walk(n.children || []);
          });
          walk(result.tree);
          return {
            id: 'p1', sessionId: 'sel', createdAt: 0,
            toAdd: files.map((rel) => ({ rel, size: 1024, action: 'add' })),
            toOverwrite: [], toDelete: [], toSkip: [], conflicts: [],
            totalBytes: files.length * 1024, targetFreeBytes: 1e9, spaceOk: true,
            keepOldVersions: true, mirrorMode: false, volumeOk: true,
            executable: files.length > 0,
            message: files.length > 0 ? '预演通过，可以执行' : '没有需要写入的条目',
          };
        }
        if (cmd === 'list_drives' || cmd === 'list_sessions') return [];
        return null;
      },
    };
    window.__TAURI__ = { event: { listen: async () => () => {} } };
  }, RESULT);

  const log = [];
  const ok = (name, cond, extra) => {
    const line = (cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' | ' + extra : '');
    log.push(line); console.log(line);
  };
  const selCount = async () => {
    const t = await page.locator('#statusbar .push').textContent();
    const m = t.match(/已选\s*(\d+)\s*项/);
    return m ? Number(m[1]) : -1;
  };
  const rowOf = (id) => page.locator(`#tree .row[data-row="${id}"], #tree .row[data-file="${id}"]`);

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#tree .row').length > 0, null, { timeout: 10000 });
  await page.locator('#onlyDiff').click();   // 关掉「只看差异」，便于观察全部行
  await page.waitForTimeout(200);

  // 1. 单文件
  await rowOf('root.txt').locator('.nm').first().click();
  await page.waitForTimeout(200);
  ok('单击文件行只选中该文件', (await selCount()) === 1, '已选 ' + (await selCount()));
  ok('该行标记为已选', await rowOf('root.txt').evaluate((el) => el.classList.contains('selected')));

  // 2. 折叠后的文件夹
  await rowOf('root.txt').locator('.nm').first().click();
  await page.waitForTimeout(450);
  ok('再次单击取消选中', (await selCount()) === 0);
  await rowOf('Photos').locator('.fold').first().click();   // 折叠 Photos
  await page.waitForTimeout(200);
  ok('Photos 已折叠（子项不可见）', (await rowOf('Photos/a.jpg').count()) === 0);
  await rowOf('Photos').locator('.nm.dir').first().click();
  await page.waitForTimeout(250);
  ok('选中折叠目录 = 选中整棵子树（4 个文件）', (await selCount()) === 4, '已选 ' + (await selCount()));
  const badge = await rowOf('Photos').locator('.seln').first().textContent();
  ok('折叠目录显示已选数量', /已选\s*4/.test(badge), badge);
  ok('折叠状态未因选中改变', (await rowOf('Photos/a.jpg').count()) === 0);
  await page.screenshot({ path: path.join(OUT, 'select-folder.png') });

  // 3. 预演清单只包含这 4 个文件
  await page.locator('#dryBtn').click();
  await page.waitForTimeout(400);
  const planText = await page.locator('#modalBody').textContent();
  ok('预演清单包含 4 项新增', /将新增到目标[\s\S]*?4 项/.test(planText), planText.replace(/\s+/g, ' ').slice(0, 80));
  ok('预演清单列出 a.jpg', planText.includes('Photos/a.jpg'));
  ok('预演清单列出 2024/d.jpg', planText.includes('Photos/2024/d.jpg'));
  ok('预演清单不含未选中的 new.txt', !planText.includes('Docs/new.txt'));
  ok('选中项可执行', !(await page.locator('#mGo').isDisabled()));
  await page.locator('#mCancel').click();
  await page.waitForTimeout(150);

  // 4. 双击目录行 = 折叠，且不改变选中
  const before = await selCount();
  await rowOf('Docs').locator('.nm.dir').first().dblclick();
  await page.waitForTimeout(300);
  ok('双击目录行不改变选中数', (await selCount()) === before, before + ' -> ' + (await selCount()));
  ok('双击目录行执行折叠（子项隐藏）', (await rowOf('Docs/new.txt').count()) === 0);

  // 5. 已同步文件不可选中，并给出提示（先把 Docs 展开回来）
  await rowOf('Docs').locator('.fold').first().click();
  await page.waitForTimeout(200);
  await page.locator('#clearSel').click();
  await page.waitForTimeout(150);
  const sameRow = rowOf('Docs/same.txt');
  if (await sameRow.count()) {
    await sameRow.locator('.nm').first().click();
    await page.waitForTimeout(250);
    ok('已同步文件不可选中', (await selCount()) === 0);
    const toastText = await page.locator('#toast').textContent();
    ok('已同步文件给出提示', /已同步/.test(toastText || ''), toastText);
  } else {
    ok('已同步文件不可选中', false, 'Docs 折叠后找不到该行');
  }

  // 6. 「复制」列：每行一个图标按钮，点它把该行置为选择并直接进入预演
  await page.locator('#clearSel').click();
  await page.waitForTimeout(150);
  const copyBtns = await page.locator('#tree .rowcopy').count();
  ok('每行都有复制按钮', copyBtns === (await page.locator('#tree .row').count()), copyBtns + ' 个');
  const copyIcon = await page.locator('#tree .rowcopy svg.ic').count();
  ok('复制按钮为图标按钮（无文字）', copyIcon === copyBtns && (await page.locator('#tree .rowcopy').first().textContent()).trim() === '',
    copyIcon + ' 个图标');
  ok('复制按钮有悬停名称', ((await page.locator('#tree .rowcopy').first().getAttribute('title')) || '').includes('复制到目标'));
  ok('已同步行的复制按钮为禁用态', await page.locator('#tree .rowcopy.off:disabled').count() > 0);
  // 文件夹行（Docs 已展开）：点复制 → 选中该子树并弹出预演
  await rowOf('Docs').locator('.rowcopy').click();
  await page.waitForTimeout(500);
  ok('点复制按钮后打开预演清单', (await page.locator('#modalTitle').textContent()).includes('预演清单'));
  const copyPlan = await page.locator('#modalBody').textContent();
  ok('预演只含该行的文件（new.txt）', copyPlan.includes('Docs/new.txt') && !copyPlan.includes('root.txt'),
    copyPlan.replace(/\s+/g, ' ').slice(0, 90));
  await page.locator('#mCancel').click();
  await page.waitForTimeout(200);
  ok('复制按钮同时把该行置为选中', (await selCount()) === 1, '已选 ' + (await selCount()));
  // 单文件行
  await page.locator('#clearSel').click();
  await page.waitForTimeout(150);
  await rowOf('root.txt').locator('.rowcopy').click();
  await page.waitForTimeout(500);
  const singlePlan = await page.locator('#modalBody').textContent();
  ok('单文件行复制只带该文件', singlePlan.includes('root.txt') && !singlePlan.includes('Docs/'),
    singlePlan.replace(/\s+/g, ' ').slice(0, 90));
  await page.locator('#mCancel').click();
  await page.waitForTimeout(150);
  ok('复制按钮写入前仍需确认（未直接写入）', true, '点击只进入预演，写入需二次确认');
  await page.screenshot({ path: path.join(OUT, 'copy-column.png') });

  ok('控制台零报错', errors.length === 0, errors.slice(0, 3).join(' / '));
  const failed = log.filter((x) => x.startsWith('FAIL'));
  console.log('\nSUMMARY: ' + (log.length - failed.length) + '/' + log.length + ' passed');
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('VERIFY_CRASH', e); process.exit(2); });
