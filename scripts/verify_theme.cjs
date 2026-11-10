/* 外观验证：应用图标 + 配色饱和度。
   1) 左上角必须是 <img src="icon.png">，且图片真的加载成功（naturalWidth>0）；
   2) 六态行底色必须是「有颜色」而非透明，且与改版前的灰调相比更饱和；
   3) 深色主题下也能取到颜色值。
   用法：node scripts/verify_theme.cjs */
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

  const log = [];
  const ok = (name, cond, extra) => {
    const line = (cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' | ' + extra : '');
    log.push(line); console.log(line);
  };

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#tree .row').length > 0, null, { timeout: 10000 });

  // 1. 左上角图标
  const logo = await page.evaluate(() => {
    const el = document.querySelector('.titlebar .logo');
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return {
      found: true,
      tag: el.tagName,
      src: el.getAttribute('src'),
      loaded: el.tagName === 'IMG' ? el.complete && el.naturalWidth > 0 : false,
      natural: el.tagName === 'IMG' ? el.naturalWidth : 0,
      box: [Math.round(r.width), Math.round(r.height)],
    };
  });
  ok('左上角是图片元素', logo.found && logo.tag === 'IMG', logo.tag);
  ok('图片指向应用图标', /icon\.png$/.test(logo.src || ''), logo.src);
  ok('图标确实加载成功', logo.loaded, 'naturalWidth=' + logo.natural);
  ok('图标尺寸为 22×22', logo.box[0] === 22 && logo.box[1] === 22, logo.box.join('x'));

  // 2. 配色饱和度：把 hex 转 HSL 取 S
  const S = (hex) => {
    const n = parseInt(hex.replace('#', ''), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx === mn) return 0;
    const l = (mx + mn) / 2;
    return (mx - mn) / (1 - Math.abs(2 * l - 1));
  };
  const readVars = () => page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const names = ['--ok', '--diff', '--left', '--conflict', '--primary'];
    const out = {};
    names.forEach((n) => { out[n] = cs.getPropertyValue(n).trim(); });
    return out;
  });
  const toHex = (v) => {
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    const m = v.match(/\d+/g);
    if (!m) return '#000000';
    return '#' + m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  };
  const light = await readVars();
  // 改版前（低饱和）参考值
  const before = { '--ok': '#1a7f4b', '--diff': '#c83838', '--left': '#b5760d', '--conflict': '#6f4fb0', '--primary': '#1f5fa8' };
  let improved = 0;
  const rows = [];
  for (const k of Object.keys(before)) {
    const now = S(toHex(light[k]));
    const old = S(before[k]);
    if (now > old + 0.02) improved++;
    rows.push(`${k}: ${(old * 100).toFixed(0)}% → ${(now * 100).toFixed(0)}%`);
  }
  ok('主要状态色饱和度均有提升', improved === Object.keys(before).length, rows.join('  '));

  // 3. 整行底色必须有颜色（非透明），并比改版前更饱和
  const tints = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return ['--tint-ok', '--tint-diff', '--tint-left', '--tint-conflict']
      .reduce((o, n) => (o[n] = cs.getPropertyValue(n).trim(), o), {});
  });
  const beforeTints = { '--tint-ok': '#ecf8f1', '--tint-diff': '#fdeaea', '--tint-left': '#fcf1dd', '--tint-conflict': '#f2ecfd' };
  let tintBetter = 0;
  for (const k of Object.keys(beforeTints)) {
    if (S(toHex(tints[k])) > S(beforeTints[k]) + 0.005) tintBetter++;
  }
  ok('整行状态底色饱和度提升', tintBetter >= 3,
    Object.keys(beforeTints).map((k) => `${k} ${(S(beforeTints[k]) * 100).toFixed(0)}%→${(S(toHex(tints[k])) * 100).toFixed(0)}%`).join('  '));

  // 4. 实际渲染出来的行确实带底色
  const bg = await page.locator('#tree .row.t-left').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  ok('行背景色已生效（非透明）', bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', bg);

  await page.screenshot({ path: path.join(OUT, 'theme-light.png') });

  // 5. 深色主题
  await page.locator('#themeBtn').click();
  await page.waitForTimeout(300);
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok('深色主题生效', darkBg === 'rgb(8, 9, 10)', darkBg);

  // 2b. 深色以中性黑为主色：面板/文字接近无彩色，不能带蓝调或棕调
  const darkPalette = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const pick = (n) => cs.getPropertyValue(n).trim();
    return {
      bg: pick('--bg'), panel: pick('--panel'), panel3: pick('--panel3'),
      border: pick('--border'), text: pick('--text'),
      tintLeft: pick('--tint-left'), tintRight: pick('--tint-right'),
      tintOk: pick('--tint-ok'), tintDiff: pick('--tint-diff'),
    };
  });
  const rgb = (v) => {
    const h = toHex(v).slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  };
  const neutral = (v, tol) => {
    const [r, g, b] = rgb(v);
    return Math.max(r, g, b) - Math.min(r, g, b) <= tol;
  };
  ok('深色面板为中性黑灰（无蓝调）',
    ['bg', 'panel', 'panel3', 'border'].every((k) => neutral(darkPalette[k], 6)),
    Object.entries(darkPalette).filter(([k]) => ['bg', 'panel', 'panel3', 'border'].includes(k)).map(([k, v]) => k + '=' + v).join(' '));
  ok('深色正文为中性浅灰', neutral(darkPalette.text, 6), darkPalette.text);
  ok('仅源有行底色不再是棕黄色（改中性灰）',
    neutral(darkPalette.tintLeft, 6) && rgb(darkPalette.tintLeft)[2] >= rgb(darkPalette.tintLeft)[0],
    darkPalette.tintLeft + ' rgb(' + rgb(darkPalette.tintLeft).join(',') + ')');
  ok('其余行底色也保持中性', neutral(darkPalette.tintRight, 8) && neutral(darkPalette.tintOk, 10), darkPalette.tintRight + ' / ' + darkPalette.tintOk);
  ok('深色状态文字色仍保持可辨识的色相', !neutral(darkPalette.tintDiff, 2), 'tint-diff=' + darkPalette.tintDiff);

  const dl = await readVars();
  ok('深色主题也使用新配色', toHex(dl['--primary']).toLowerCase() !== '#1f5fa8', dl['--primary']);
  await page.screenshot({ path: path.join(OUT, 'theme-dark.png') });

  // 2c. 标题栏只显示产品简介（不拼会话名），底边图例默认收起只露 i 图标
  const bar = await page.evaluate(() => {
    const tb = document.querySelector('.titlebar');
    const lgn = document.getElementById('legend');
    const body = document.getElementById('legendBody');
    const btn = document.getElementById('legendBtn');
    return {
      tsub: [...tb.querySelectorAll('.tsub')].map((x) => x.textContent.trim()),
      legendText: tb.textContent.replace(/\s+/g, ' ').trim(),
      hasSessionLabel: !!document.getElementById('sessionLabel'),
      legendOpen: lgn.classList.contains('open'),
      bodyVisible: body ? getComputedStyle(body).display !== 'none' : true,
      btnVisible: btn ? btn.getBoundingClientRect().height > 0 : false,
      legendH: Math.round(lgn.getBoundingClientRect().height),
    };
  });
  ok('标题栏只保留一句产品简介', bar.tsub.length === 1 && bar.tsub[0] === '轻量化文件备份同步工具', bar.tsub.join(' | '));
  ok('标题栏不再显示会话名', !bar.hasSessionLabel && !/会话|→/.test(bar.legendText), bar.legendText.slice(0, 60));
  ok('图例默认收起', !bar.legendOpen && !bar.bodyVisible, 'open=' + bar.legendOpen);
  ok('图例收起时只显示 i 图标', bar.btnVisible && bar.legendH <= 28, 'h=' + bar.legendH);

  await page.locator('#legendBtn').click();
  await page.waitForTimeout(150);
  const legendAfter = await page.evaluate(() => {
    const lgn = document.getElementById('legend');
    const body = document.getElementById('legendBody');
    return {
      open: lgn.classList.contains('open'),
      visible: getComputedStyle(body).display !== 'none',
      items: body.querySelectorAll('.item').length,
      expanded: document.getElementById('legendBtn').getAttribute('aria-expanded'),
    };
  });
  ok('点击 i 图标展开图例', legendAfter.open && legendAfter.visible && legendAfter.items === 6, 'items=' + legendAfter.items);
  ok('展开后 aria-expanded 同步', legendAfter.expanded === 'true', legendAfter.expanded);

  ok('控制台零报错', errors.length === 0, errors.slice(0, 3).join(' / '));
  const failed = log.filter((x) => x.startsWith('FAIL'));
  console.log('\nSUMMARY: ' + (log.length - failed.length) + '/' + log.length + ' passed');
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('VERIFY_CRASH', e); process.exit(2); });
