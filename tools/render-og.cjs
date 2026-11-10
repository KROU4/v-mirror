// Social card public/og.png (1200x630) from the V portraits in public/portraits (run tools/render-portraits.cjs first).
// NODE_PATH="$(npm root -g)" node tools/render-og.cjs
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const mime = (p) => (p.endsWith('.woff2') ? 'font/woff2' : 'image/webp');
const url = (p) => `data:${mime(p)};base64,` + fs.readFileSync(path.join(ROOT, p)).toString('base64');
const html = `<!doctype html><html><head><style>
@font-face { font-family: T; src: url('${url('node_modules/@fontsource-variable/tektur/files/tektur-latin-standard-normal.woff2')}') format('woff2'); font-weight: 400 900; font-stretch: 75% 100%; }
* { box-sizing: border-box; }
body { margin: 0; width: 1200px; height: 630px; overflow: hidden; font-family: T; font-stretch: 92%; color: #ffd8cf;
  background: radial-gradient(ellipse 60% 70% at 72% 55%, rgba(120, 30, 40, 0.55), transparent 75%), linear-gradient(180deg, #15131a, #0a0b0f); }
.frame { position: absolute; inset: 0; }
.frame::before { content: ''; position: absolute; left: 24px; right: 24px; top: 40px; height: 1px; background: linear-gradient(90deg, rgba(255,95,88,.5) 0 30%, transparent 30% 56%, rgba(255,95,88,.5) 56% 100%); }
.frame::after { content: ''; position: absolute; left: 12px; top: 80px; bottom: 80px; width: 6px; background: repeating-linear-gradient(180deg, #c4555a 0 1px, transparent 1px 9px); opacity: .5; }
.txt { position: absolute; left: 64px; top: 116px; width: 500px; }
.brand { color: #ff5f58; font-weight: 700; letter-spacing: .12em; font-size: 22px; }
h1 { margin: 22px 0 0; font-weight: 400; font-size: 56px; line-height: 1; letter-spacing: .03em; text-transform: uppercase; color: #75d2d5;
  padding-bottom: 14px; border-bottom: 4px solid #75d2d5; display: inline-block; }
p { margin: 26px 0 0; font-size: 24px; line-height: 1.3; font-weight: 500; letter-spacing: .03em; text-transform: uppercase; color: #ff6a63; }
.tags { margin-top: 34px; display: flex; gap: 10px; }
.tags span { border: 1px solid rgba(94,242,255,.55); color: #5ef2ff; padding: 8px 12px; font-size: 18px; letter-spacing: .06em; text-transform: uppercase; }
.pics { position: absolute; right: 10px; bottom: 0; height: 560px; display: flex; align-items: flex-end; }
.pics img { height: 540px; -webkit-mask-image: radial-gradient(ellipse 58% 64% at 50% 38%, #000 66%, transparent 100%); }
.pics img + img { margin-left: -170px; height: 500px; }
</style></head><body><div class="frame"></div>
<div class="txt"><div class="brand">V-MIRROR</div><h1>V from a photo</h1>
<p>Cyberpunk 2077 2.5 character creator replica: match V to a photo, copy the numbers into the game</p>
<div class="tags"><span>RU / EN</span><span>Live 3D</span><span>No server</span></div></div>
<div class="pics"><img src="${url('public/portraits/v_pwa.webp')}"><img src="${url('public/portraits/v_pma.webp')}"></div>
</body></html>`;
(async () => {
  const tmp = path.join(require('os').tmpdir(), 'v-mirror-og.html');
  fs.writeFileSync(tmp, html);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto('file:///' + tmp.replace(/\\/g, '/'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(ROOT, 'public', 'og.png') });
  await browser.close();
  console.log('ok');
})();
