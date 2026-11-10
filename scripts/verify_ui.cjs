/* 前端演示模式交互验证（不依赖 Tauri 运行时） */
const path = require('path');
const fs = require('fs');

// 依次尝试：显式环境变量 → 本机 stageshow 技能内置 → 项目/全局安装
function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    process.env.HOME ? path.join(process.env.HOME, '.workbuddy/skills/stageshow/node_modules/playwright-core') : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.workbuddy/skills/stageshow/node_modules/playwright-core') : null,
    'playwright-core',
    'playwright',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c).chromium; } catch (e) { /* 继续尝试下一个 */ }
  }
  throw new Error('未找到 playwright(-core)。请安装后重试，或用 PLAYWRIGHT_CORE 指定模块路径。');
}
const chromium = loadChromium();

// 允许用环境变量覆盖；默认路径不存在时交给 playwright 自行解析
const EXE = process.env.CHROME_BIN ||
  'C:/Users/wangm/AppData/Local/ms-playwright/chromium_headless_shell-1161/chrome-win/headless_shell.exe';
const URL = 'file:///' + path.resolve(__dirname, '../src/index.html').replace(/\\/g, '/');
const OUT = path.resolve(__dirname, '../.verify');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const launchOpts = { headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] };
  if (EXE && fs.existsSync(EXE)) launchOpts.executablePath = EXE;
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const log = [];
  const ok = (name, cond, extra) => { const line=(cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' | ' + extra : ''); log.push(line); console.log(line); };

  await page.goto(URL, { waitUntil: 'load' });
  // 演示模式首次比对有约 420ms 的模拟延时，等首屏行渲染出来再断言
  await page.waitForFunction(() => document.querySelectorAll('#tree .row').length > 0, null, { timeout: 5000 })
    .catch(() => {});
  await page.waitForTimeout(200);

  // 1. 初始渲染
  const rows = await page.locator('#tree .row').count();
  ok('演示数据渲染行数', rows === 5 || rows === 7, 'rows=' + rows);
  const mode = await page.locator('#modePill').textContent();
  ok('自动进入演示模式', mode.includes('演示'), mode);
  const badge = await page.locator('#statusbar').textContent();
  ok('六态统计条', /已同步 5/.test(badge) && /冲突 1/.test(badge), badge.trim().replace(/\s+/g, ' ').slice(0, 130));

  // 2. 展开全部 + 只看差异
  await page.locator('#onlyDiff').click();
  const rows2 = await page.locator('#tree .row').count();
  ok('关闭「只看差异」后行数增加', rows2 > rows, rows + ' -> ' + rows2);
  await page.locator('#onlyDiff').click();

  // 3. 级联勾选
  await page.locator('#selectDiff').click();
  const selText = await page.locator('#statusbar .push').textContent();
  ok('全选差异启用主按钮', !(await page.locator('#backupBtn').isDisabled()), selText.trim().replace(/\s+/g, ' '));
  ok('勾选数量 3 项', /已选 3 项/.test(selText), selText.trim().replace(/\s+/g, ' ').slice(0, 80));

  // 4. 预演清单
  await page.locator('#dryBtn').click();
  await page.waitForTimeout(250);
  const title = await page.locator('#modalTitle').textContent();
  const body = await page.locator('#modalBody').textContent();
  ok('预演弹窗标题', title.includes('预演清单'), title);
  ok('预演含新增/覆盖/冲突分类', body.includes('将新增到目标') && body.includes('将覆盖目标同名文件') && body.includes('冲突'));
  ok('冲突逐项处置选择器存在', await page.locator('[data-res]').count() === 1);
  ok('镜像与版本保护开关存在', await page.locator('#keepOld').count() === 1 && await page.locator('#mirror').count() === 1);
  await page.screenshot({ path: path.join(OUT, 'modal.png') });

  // 5. 冲突未处置时不可执行
  await page.locator('#mGo').click();
  await page.waitForTimeout(250);
  ok('冲突未处置时确认执行禁用', await page.locator('#mExec').isDisabled());

  // 6. 处置冲突后可确认
  await page.locator('[data-res]').selectOption('keep');
  await page.waitForTimeout(300);
  ok('处置冲突后确认执行启用', !(await page.locator('#mExec').isDisabled()));

  // 7. 镜像二次确认
  await page.locator('#mirror').click({force:true});
  await page.waitForTimeout(200);
  ok('镜像模式触发二次确认', (await page.locator('#modalTitle').textContent()).includes('二次确认'));
  await page.locator('#mNo').click();
  await page.waitForTimeout(250);

  // 8. 执行闭环
  await page.locator('#mExec').click();
  await page.waitForTimeout(1400);
  const done = await page.locator('#modalTitle').textContent();
  const doneBody = await page.locator('#modalBody').textContent();
  ok('执行后显示完成回执', done.includes('备份完成'), done);
  ok('回执含自动重新比对说明', doneBody.includes('自动重新比对'), doneBody.trim().replace(/\s+/g, ' ').slice(0, 120));
  await page.locator('#mDone').click();

  // 9. 深色与目录选择器
  await page.locator('#themeBtn').click();
  ok('深色主题切换', await page.locator('html').getAttribute('data-theme') === 'dark');
  await page.locator('#themeBtn').click();
  await page.locator('#srcBrowse').click();
  await page.waitForTimeout(300);
  ok('目录选择器打开', (await page.locator('#modalTitle').textContent()).includes('选择目录'));
  ok('盘符列表渲染', await page.locator('[data-drive]').count() === 2);
  await page.screenshot({ path: path.join(OUT, 'ui-dark-check.png') });
  await page.locator('#dpCancel').click();

  // 10. 目录折叠 / 展开（左右两栏同步）
  const rowsOpen = await page.locator('#tree .row').count();
  const dirRow = page.locator('#tree .row[data-row]').first();
  const caretsOf = () => dirRow.locator('.fold[data-exp]').evaluateAll(els => els.map(e => (e.classList.contains('open') ? 'open' : 'closed')));
  let carets = await caretsOf();
  ok('目录默认展开且两侧状态同步', carets.length === 2 && carets[0] === 'open' && carets[1] === 'open', carets.join(','));
  const caretBox = await dirRow.locator('.fold[data-exp]').first().boundingBox();
  ok('折叠按钮可见且有足够点击面积', !!caretBox && caretBox.width >= 16 && caretBox.height >= 16,
    caretBox ? Math.round(caretBox.width) + 'x' + Math.round(caretBox.height) : 'none');
  await dirRow.locator('.nm.dir').first().dblclick();
  await page.waitForTimeout(180);
  const rowsFolded = await page.locator('#tree .row').count();
  ok('双击目录名可折叠该目录', rowsFolded < rowsOpen, rowsOpen + ' -> ' + rowsFolded);
  carets = await caretsOf();
  ok('折叠后左右两栏状态同步', carets.length === 2 && carets[0] === 'closed' && carets[1] === 'closed', carets.join(','));
  ok('折叠行保留子树差异摘要', /子树 \d+ 处差异/.test(await dirRow.textContent()));
  await page.screenshot({ path: path.join(OUT, 'ui-fold-dir.png') });

  // 10b. 单行选中：折叠后的文件夹整行单击即可选中整棵子树
  const selectedCount = async () => {
    const t = await page.locator('#statusbar .push').textContent();
    const m = t.match(/已选\s*(\d+)\s*项/);
    return m ? Number(m[1]) : -1;
  };
  ok('初始未选中', (await selectedCount()) === 0);
  await dirRow.locator('.nm.dir').first().click();
  await page.waitForTimeout(450);
  const selAfterRow = await selectedCount();
  ok('单击折叠的文件夹行即可选中其子树', selAfterRow > 0, '已选 ' + selAfterRow + ' 项');
  const badgeText = await dirRow.locator('.seln').first().textContent().catch(() => '');
  ok('折叠行显示已选数量', /已选\s*\d+/.test(badgeText || ''), badgeText);
  ok('折叠状态未被单击改变', (await page.locator('#tree .row').count()) === rowsFolded);
  // 再单击一次取消（间隔需超过双击判定阈值）
  await dirRow.locator('.nm.dir').first().click();
  await page.waitForTimeout(450);
  ok('再次单击同一行取消选中', (await selectedCount()) === 0);

  // 10c. 单行选中：单个文件
  const fileRow = page.locator('#tree .row[data-file]').first();
  if (await fileRow.count()) {
    const fileName = (await fileRow.locator('.nm.mono').first().textContent()) || '';
    await fileRow.locator('.nm.mono').first().click();
    await page.waitForTimeout(180);
    ok('单击文件行可单独选中该文件', (await selectedCount()) === 1, fileName.trim() + ' 已选 ' + (await selectedCount()));
    await page.locator('#clearSel').click();
    await page.waitForTimeout(150);
  } else {
    ok('单击文件行可单独选中该文件', false, '当前视图没有文件行');
  }

  // 从右栏点开，左栏也必须同步展开
  await dirRow.locator('.fold[data-exp]').last().click();
  await page.waitForTimeout(250);
  ok('右栏点击可展开', (await page.locator('#tree .row').count()) === rowsOpen);
  carets = await caretsOf();
  ok('展开后左右两栏状态同步', carets[0] === 'open' && carets[1] === 'open', carets.join(','));
  // 键盘：聚焦目录行后按左方向键收起
  await dirRow.focus();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(180);
  ok('方向键可收起目录', (await page.locator('#tree .row').count()) < rowsOpen);
  // 总按钮：收起全部 → 只剩顶层；展开全部 → 恢复
  ok('收起全部按钮可用', (await page.locator('#collapseAll').getAttribute('aria-disabled')) !== 'true');
  await page.locator('#collapseAll').click();
  await page.waitForTimeout(200);
  const rowsCollapsedAll = await page.locator('#tree .row').count();
  ok('收起全部后只剩顶层目录', rowsCollapsedAll <= 3, 'rows=' + rowsCollapsedAll);
  ok('收起后「展开全部」可用、「收起全部」置灰',
    (await page.locator('#expandAll').getAttribute('aria-disabled')) !== 'true' &&
    (await page.locator('#collapseAll').getAttribute('aria-disabled')) === 'true');
  await page.locator('#expandAll').click();
  await page.waitForTimeout(200);
  ok('展开全部恢复所有子项', (await page.locator('#tree .row').count()) > rowsCollapsedAll);
  await page.locator('#onlyDiff').click();
  await page.waitForTimeout(120);
  ok('行底色按状态着色', await page.locator('#tree .row.t-conflict, #tree .row.t-diff, #tree .row.t-left').count() > 0);
  const tinted = await page.locator('#tree .row.t-diff').first().evaluate(el => getComputedStyle(el).backgroundColor);
  ok('状态行确有背景色（非透明）', tinted !== 'rgba(0, 0, 0, 0)' && tinted !== 'transparent', tinted);
  await page.locator('#onlyDiff').click();
  await page.waitForTimeout(120);
  // 搜索时自动展开，避免命中项藏在折叠目录里
  await page.locator('#searchInput').fill('会议纪要');
  await page.waitForTimeout(200);
  ok('搜索时自动展开命中目录', await page.locator('#tree .row').count() > 0);
  await page.locator('#searchInput').fill('');
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');

  // 11. 过滤规则弹窗（P1：规则可编辑并回填）
  await page.locator('#filterBtn').click();
  await page.waitForTimeout(200);
  ok('过滤规则弹窗打开', (await page.locator('#modalTitle').textContent()).includes('过滤规则'));
  await page.locator('#fExt').fill('tmp, log');
  await page.locator('#fPat').fill('~$*');
  await page.locator('#fDir').fill('.git');
  await page.locator('#fOk').click();
  await page.waitForTimeout(900);
  // 图标按钮：数量以角标显示，名称在 title 里
  const filterBadge = await page.locator('#filterCount').textContent();
  const filterTitle = await page.locator('#filterBtn').getAttribute('title');
  ok('过滤规则回显为角标', filterBadge.trim() === '4', 'badge=' + filterBadge);
  ok('过滤规则名称在悬停提示里', /已启用 4 条/.test(filterTitle || ''), filterTitle);
  await page.locator('#filterBtn').click();
  await page.waitForTimeout(200);
  ok('过滤规则可再次编辑', (await page.locator('#fExt').inputValue()).includes('tmp'));
  await page.locator('#fReset').click();
  await page.waitForTimeout(900);
  ok('清空过滤规则', (await page.locator('#filterCount').textContent()).trim() === '');

  // 11. 最终截图（浅色）
  await page.screenshot({ path: path.join(OUT, 'ui.png') });

  ok('控制台零报错', errors.length === 0, errors.slice(0, 3).join(' / '));

  console.log(log.join('\n'));
  const failed = log.filter(x => x.startsWith('FAIL'));
  console.log('\nSUMMARY: ' + (log.length - failed.length) + '/' + log.length + ' passed');
  if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('VERIFY_CRASH', e); process.exit(2); });
