// Скриншоты интерфейса для проверки вёрстки (dev-сервер должен работать на :5177).
// Использует установленный Edge/Chrome через DevTools Protocol с эмуляцией устройства,
// поэтому ширина 390 px честная (headless-окно уже ~500 px не бывает).
//   node tools/shoot.mjs .impeccable/review
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const outDir = path.resolve(process.argv[2] ?? '.impeccable/review');
mkdirSync(outDir, { recursive: true });
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const exe = BROWSERS.find(existsSync);
if (!exe) throw new Error('Не найден Edge/Chrome');
const port = 9333;
const prof = path.join(os.tmpdir(), 'v-mirror-shoot');
const proc = spawn(exe, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl;
for (let k = 0; k < 50 && !wsUrl; k++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) throw new Error('DevTools не ответил');
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

const SHOTS = [
  { name: 'desktop.png', url: 'http://localhost:5177/', w: 1440, h: 1000, mobile: false },
  { name: 'scan-empty.png', url: 'http://localhost:5177/?scan=1', w: 1440, h: 1000, mobile: false },
  { name: 'mobile.png', url: 'http://localhost:5177/', w: 390, h: 844, mobile: true, full: true },
  { name: 'mobile-scan.png', url: 'http://localhost:5177/?scan=1', w: 390, h: 844, mobile: true, full: true },
];
await send('Page.enable');
for (const s of SHOTS) {
  await send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: s.mobile ? 2 : 1, mobile: s.mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: s.mobile });
  await send('Page.navigate', { url: s.url });
  await sleep(2500);
  const metrics = await evaluate(
    `({cw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight})`,
  );
  const clip = s.full ? { x: 0, y: 0, width: s.w, height: metrics.sh, scale: 1 } : undefined;
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!s.full, ...(clip ? { clip } : {}) });
  writeFileSync(path.join(outDir, s.name), Buffer.from(shot.data, 'base64'));
  console.log(`${s.name}: clientWidth=${metrics.cw} scrollWidth=${metrics.sw} height=${metrics.sh}`);
}
ws.close();
proc.kill();
