import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream';

const root = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 40 * 1024 * 1024;

/** realpath ближайшего существующего предка: junction/симлинк внутри не выведет запись наружу. */
function realDir(p: string): string {
  let cur = p;
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(fs.realpathSync(cur), path.relative(cur, p));
}

/**
 * Только для разработки: страница калибровки (tools/calibrate) сохраняет
 * результаты рендера морфов на диск через POST /__save?file=...
 * Разрешены .json и .png внутри tools/local и src/data. Запрос обязан нести
 * заголовок X-Vmirror-Save (это включает CORS-preflight, так что чужая
 * открытая вкладка не может писать на диск) и прийти с того же origin.
 */
function devSave(): Plugin {
  return {
    name: 'dev-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save', (req, res) => {
        const fail = (code: number, msg: string) => {
          res.statusCode = code;
          res.end(msg);
        };
        const site = req.headers['sec-fetch-site'];
        const origin = req.headers.origin;
        const host = req.headers.host;
        if (req.method !== 'POST' || req.headers['x-vmirror-save'] !== '1') return fail(403, 'forbidden');
        if (site && site !== 'same-origin') return fail(403, 'cross-site');
        if (origin && host) {
          let oh: string;
          try {
            oh = new URL(origin).host;
          } catch {
            return fail(403, 'bad origin');
          }
          if (oh !== host) return fail(403, 'cross-origin');
        }

        const url = new URL(req.url ?? '', 'http://x');
        const rel = url.searchParams.get('file') ?? '';
        if (!/\.(json|png)$/i.test(rel) || /[\0<>:"|?*]/.test(rel.replace(/^[A-Za-z]:/, ''))) return fail(400, 'bad file');
        let abs: string;
        let okDirs: string[];
        try {
          abs = realDir(path.resolve(root, rel));
          okDirs = [realDir(path.resolve(root, 'tools/local')), realDir(path.resolve(root, 'src/data'))];
        } catch {
          return fail(400, 'bad path');
        }
        if (!okDirs.some((d) => abs.startsWith(d + path.sep))) return fail(400, 'bad path');

        const chunks: Buffer[] = [];
        let size = 0;
        let aborted = false;
        req.on('data', (c: Buffer) => {
          if (aborted) return;
          size += c.length;
          if (size > MAX_BODY) {
            aborted = true;
            fail(413, 'too large');
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on('end', () => {
          if (aborted) return;
          try {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            let body = Buffer.concat(chunks);
            if (/\.png$/i.test(rel)) body = Buffer.from(body.toString('utf8').replace(/^data:image\/png;base64,/, ''), 'base64');
            fs.writeFileSync(abs, body);
            res.end('ok');
          } catch (e) {
            fail(500, `write failed: ${(e as Error).message}`);
          }
        });
        req.on('error', () => {
          aborted = true;
        });
      });
    },
  };
}

/**
 * Dev server only: the local asset pack (tools/local, never committed — CDPR assets) is
 * served at /game/<section>/... and /game/pack.json. The build (and vite preview of it) has
 * no such route: there the user connects a pack folder in the browser (src/assets/pack.ts).
 * VM_PACK_DIR=<folder> serves another pack (e.g. one built by npm run pack) instead.
 */
const LOCAL_PACK = process.env.VM_PACK_DIR || 'tools/local';
const GAME_DIRS: Record<string, string> = Object.fromEntries(
  ['glb', 'hair', 'renders', 'tex', 'body', 'swatches', 'head'].map((s) => [s, path.posix.join(LOCAL_PACK.replace(/\\/g, '/'), s)]),
);
const GAME_TYPES: Record<string, string> = {
  glb: 'model/gltf-binary',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};
/** Не больше 5 сегментов после раздела; каждый — без ведущей точки и без «..» */
const SEGMENT = /^[\w][\w.-]*$/;
const MAX_DEPTH = 5;

/** /game/<раздел>/<путь> → относительный путь файла в tools/local или null. Экспорт — для тестов. */
export function gameAssetPath(urlPath: string): { file: string; ext: string } | null {
  if (urlPath === '/pack.json') return { file: path.join(LOCAL_PACK, 'pack.json'), ext: 'json' };
  const parts = urlPath.split('/');
  if (parts[0] !== '' || parts.length < 3) return null;
  const section = parts[1];
  const rest = parts.slice(2);
  if (!Object.hasOwn(GAME_DIRS, section) || rest.length > MAX_DEPTH) return null;
  if (!rest.every((s) => SEGMENT.test(s) && !s.includes('..'))) return null;
  const ext = /\.([a-z0-9]+)$/i.exec(rest[rest.length - 1])?.[1].toLowerCase() ?? '';
  if (!Object.hasOwn(GAME_TYPES, ext)) return null;
  return { file: path.join(GAME_DIRS[section], ...rest), ext };
}

function gameAssets(): Plugin {
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const notFound = (code = 404) => {
      res.statusCode = code;
      res.end(code === 400 ? 'bad request' : 'not found');
    };
    let p: string;
    try {
      p = decodeURIComponent((req.url ?? '').split('?')[0]);
    } catch {
      return notFound(400); // битая %-последовательность не должна ронять мидлварь
    }
    if (p.includes('\0') || p.includes('\\')) return notFound(400);
    const hit = gameAssetPath(p);
    if (!hit) return notFound();
    const file = path.resolve(root, hit.file);
    fs.stat(file, (err, st) => {
      // pack.json is optional for a dev pack: answer "nothing" without a console error
      if ((err || !st.isFile()) && p === '/pack.json') {
        res.statusCode = 204;
        return res.end();
      }
      if (err || !st.isFile()) return notFound();
      // Выгрузку можно пересобрать — кешируем с проверкой, а не на час вслепую
      const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'no-cache');
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        return res.end();
      }
      res.setHeader('Content-Type', GAME_TYPES[hit.ext]);
      res.setHeader('Content-Length', String(st.size));
      if (req.method === 'HEAD') return res.end();
      // pipeline закрывает файл, если клиент оборвал загрузку
      pipeline(fs.createReadStream(file), res, () => {});
    });
  };
  return {
    name: 'game-assets',
    configureServer(server) {
      server.middlewares.use('/game', handler);
    },
  };
}

/** Public base path of the build, e.g. VITE_BASE=/v-mirror/ for GitHub Pages project sites. */
export function basePath(raw: string | undefined): string {
  const b = (raw ?? '').trim();
  if (!b || b === '/' || b === './') return b === './' ? './' : '/';
  if (/^https?:\/\//.test(b)) return b.endsWith('/') ? b : b + '/';
  // Git Bash/MSYS rewrites VITE_BASE=/v-mirror/ into "C:/Program Files/Git/v-mirror/":
  // a drive letter, a colon or a space can only come from such a rewrite
  if (/^[A-Za-z]:|:|\s/.test(b))
    throw new Error(`VITE_BASE looks like a file path (${b}). In Git Bash run MSYS_NO_PATHCONV=1 VITE_BASE=/v-mirror/ npm run build, or use PowerShell.`);
  return '/' + b.replace(/^\/+|\/+$/g, '') + '/';
}

/**
 * Content-Security-Policy of the static site (GitHub Pages cannot send headers, so it is a
 * meta tag). Network access only to the site itself and openrouter.ai: the OpenRouter key in
 * localStorage cannot be sent anywhere else, glTF from a pack cannot beacon out, and the
 * usage-metrics logger of MediaPipe (odml.pa.googleapis.com) is blocked.
 * WebAssembly (MediaPipe) needs 'wasm-unsafe-eval'; pack files are blob: URLs.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self' https://openrouter.ai blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

/** Public URL of the site for canonical/OG tags (VITE_SITE_URL, default: the GitHub Pages project site). */
export function siteUrl(raw: string | undefined, base: string): string {
  const s = (raw ?? '').trim();
  if (/^https?:\/\//.test(s)) return s.endsWith('/') ? s : s + '/';
  return 'https://krou4.github.io' + (base.startsWith('/') ? base : '/');
}

/**
 * Static hosting (GitHub Pages): absolute site URL in the meta tags, and 404.html = the app,
 * so a mistyped deep link still opens the editor instead of the host's error page.
 */
function staticSite(site: string): Plugin {
  return {
    name: 'static-site',
    apply: 'build',
    enforce: 'post',
    // build only: dev needs the inline react-refresh preamble, which this policy forbids
    transformIndexHtml: (html) =>
      html
        .replaceAll('%SITE_URL%', site)
        .replace(
          /<head>/i,
          `<head>
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />`,
        ),
    writeBundle(options) {
      const dir = options.dir;
      if (dir && fs.existsSync(path.join(dir, 'index.html'))) fs.copyFileSync(path.join(dir, 'index.html'), path.join(dir, '404.html'));
    },
  };
}

export default defineConfig(({ command }) => {
  // dev with local assets: pack.ts uses the /game route instead of asking for a folder
  const devPack = command === 'serve' && fs.existsSync(path.resolve(root, LOCAL_PACK, 'body', 'manifest.json'));
  const base = basePath(process.env.VITE_BASE);
  return {
    base,
    plugins: [react(), devSave(), gameAssets(), staticSite(siteUrl(process.env.VITE_SITE_URL, base))],
    define: { 'import.meta.env.VITE_DEV_PACK': JSON.stringify(devPack ? 'true' : 'false') },
    server: { port: 5177, strictPort: true },
    // the catalog (~2.6 MB of data) as JSON.parse('…'): V8 parses that much faster than a literal
    json: { stringify: true },
    build: {
      sourcemap: false,
      // the catalog data (both body types, ~1.3 MB each) dominates the entry; keep it and React in
      // their own long-lived chunks so an app update does not re-download them
      chunkSizeWarningLimit: 3200,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'catalog', test: /[\\/]src[\\/]data[\\/]catalog\./ },
              { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            ],
          },
        },
      },
    },
    test: { environment: 'node' },
  };
});
