// Портреты для плиток «Тип тела»: tools/local/renders/v_pma.png и v_pwa.png (прозрачный фон, 360×450).
// Рендер настоящим 3D-движком приложения: облик по умолчанию, строка «Цвет кожи» (голова и плечи,
// вполоборота, игровой свет), весь интерфейс скрыт. Нужны dev-сервер на :5177 и Playwright
// (глобальный пакет: NODE_PATH="$(npm root -g)" node tools/render-portraits.cjs).
// Окно открывается на втором мониторе (--window-position=1920,0).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = process.argv[2] || path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'local', 'renders');
const W = 360, H = 450;
(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1940,1200', '--window-position=1920,0'],
  });
  const logs = [];
  for (const [gender, file] of [['male', 'v_pma.png'], ['female', 'v_pwa.png']]) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const seen = new Set();
    page.on('pageerror', (e) => {
      if (seen.has(e.message)) return;
      seen.add(e.message);
      logs.push(`[${gender}] pageerror ${e.message} :: ${(e.stack || '').split('\n').slice(0, 5).join(' | ')}`);
    });
    await page.addInitScript((g) => {
      try {
        localStorage.clear();
        localStorage.setItem('vm.gender', JSON.stringify(g));
      } catch {}
    }, gender);
    await page.goto('http://localhost:5177/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.head[data-status="ready"]', { timeout: 180000 });
    await page.addStyleTag({
      content: `html, body, #root, .cc { background: transparent !important; }
        .cc > :not(.cc-stage), .info, .picker, .toast-host, .head-loading { visibility: hidden !important; }`,
    });
    await page.waitForTimeout(6000);
    // Голова и плечи: рамка вокруг головы, найденная по непрозрачным пикселям холста
    const full = await page.screenshot({ omitBackground: true });
    const box = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      // Верх головы — первая строка с непрозрачным пикселем; центр головы — середина
      // непрозрачного отрезка на 18% ниже макушки
      let top = -1;
      for (let y = 0; y < c.height && top < 0; y++) for (let i = 0; i < c.width; i++) if (d[(y * c.width + i) * 4 + 3] > 40) { top = y; break; }
      const probe = (y) => {
        let l = -1, r = -1;
        for (let i = 0; i < c.width; i++) if (d[(y * c.width + i) * 4 + 3] > 40) { if (l < 0) l = i; r = i; }
        return [l, r];
      };
      const [l1, r1] = probe(top + 200);
      return { top, cx: Math.round((l1 + r1) / 2), headW: r1 - l1, w: c.width, h: c.height };
    }, full.toString('base64'));
    logs.push(`[${gender}] box ${JSON.stringify(box)}`);
    // Один масштаб для обоих тел (окно 1920×1080, кадр головы задаёт сама сцена); макушка на 8% высоты
    if (box.top < 0) throw new Error(`${gender}: на холсте нет персонажа — сцена не отрисовалась`);
    const cropW = 620;
    const cropH = Math.round((cropW * H) / W);
    const cx = box.cx;
    const cy0 = Math.max(0, box.top - Math.round(cropH * 0.08));
    const png = await page.evaluate(async ({ b64, sx, sy, sw, sh, W, H }) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
      return c.toDataURL('image/png').split(',')[1];
    }, { b64: full.toString('base64'), sx: cx - cropW / 2, sy: cy0, sw: cropW, sh: cropH, W, H });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(png, 'base64'));
    logs.push(`[${gender}] wrote ${file}`);
    await ctx.close();
  }
  console.log(logs.join('\n'));
  await browser.close();
})();
