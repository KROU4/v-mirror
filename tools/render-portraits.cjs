// V portrait illustrations for the body-type tiles and the no-pack hero:
// public/portraits/v_pma.webp and v_pwa.webp (720×900, transparent, head and shoulders).
// They are screenshots of the app's own 3D engine (default look, "Skin tone" row, game
// lighting) with the whole interface hidden — not files from the game.
// Needs the dev server on :5177 with a local asset pack, Playwright (global package) and ffmpeg:
//   NODE_PATH="$(npm root -g)" node tools/render-portraits.cjs
// The window opens on the second monitor (--window-position=1920,0).
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = process.argv[2] || path.join(__dirname, '..');
const RAW = path.join(ROOT, 'tools', 'local', 'renders');
const OUT = path.join(ROOT, 'public', 'portraits');
const W = 720, H = 900;
/** crop width in CSS px at 1920×1080: head and shoulders, the chest stays out of frame */
const CROP_W = 560;

(async () => {
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1940,1200', '--window-position=1920,0'],
  });
  const logs = [];
  for (const [gender, file] of [['male', 'v_pma'], ['female', 'v_pwa']]) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => logs.push(`[${gender}] pageerror ${e.message}`));
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
    // let the idle animation settle on open eyes
    await page.waitForTimeout(9300);
    const full = await page.screenshot({ omitBackground: true });
    const res = await page.evaluate(
      async ({ b64, CROP_W, W, H }) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height).data;
        // top of the head: first row with an opaque pixel; head centre 200 css px below it
        let top = -1;
        for (let y = 0; y < c.height && top < 0; y++) for (let i = 0; i < c.width; i++) if (d[(y * c.width + i) * 4 + 3] > 40) { top = y; break; }
        if (top < 0) return null;
        const s = img.width / 1920;
        const probe = (y) => {
          let l = -1, r = -1;
          for (let i = 0; i < c.width; i++) if (d[(y * c.width + i) * 4 + 3] > 40) { if (l < 0) l = i; r = i; }
          return [l, r];
        };
        const [l1, r1] = probe(top + Math.round(200 * s));
        const cw = Math.round(CROP_W * s);
        const ch = Math.round((cw * H) / W);
        const o = document.createElement('canvas');
        o.width = W;
        o.height = H;
        const ox = o.getContext('2d');
        ox.imageSmoothingQuality = 'high';
        ox.drawImage(img, (l1 + r1) / 2 - cw / 2, Math.max(0, top - Math.round(ch * 0.07)), cw, ch, 0, 0, W, H);
        return o.toDataURL('image/png').split(',')[1];
      },
      { b64: full.toString('base64'), CROP_W, W, H },
    );
    if (!res) throw new Error(`${gender}: no character on the canvas — the scene did not render`);
    const png = path.join(RAW, `${file}.png`);
    fs.writeFileSync(png, Buffer.from(res, 'base64'));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-c:v', 'libwebp', '-pix_fmt', 'yuva420p', '-quality', '84', '-compression_level', '6', path.join(OUT, `${file}.webp`)]);
    logs.push(`[${gender}] wrote public/portraits/${file}.webp`);
    await ctx.close();
  }
  console.log(logs.join('\n'));
  await browser.close();
})();
