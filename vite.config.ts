import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * Меши головы и причёсок из локальной выгрузки игры (tools/local, в git не попадает)
 * отдаются по /game/... и в dev, и в preview. Нет выгрузки — 404, и приложение
 * показывает схематичный портрет вместо 3D-головы.
 */
const GAME_DIRS: Record<string, string> = { glb: 'tools/local/glb', hair: 'tools/local/hair', renders: 'tools/local/renders' };
function gameAssets(): Plugin {
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const m = /^\/([a-z]+)\/((?:(?:male|female)\/)?[\w.-]+\.(glb|json|png))$/.exec(decodeURIComponent((req.url ?? '').split('?')[0]));
    const dir = m && GAME_DIRS[m[1]];
    if (!m || !dir || m[2].includes('..')) {
      res.statusCode = 404;
      return res.end('not found');
    }
    const file = path.join(root, dir, m[2]);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.statusCode = 404;
        return res.end('not found');
      }
      res.setHeader('Content-Type', m[3] === 'json' ? 'application/json' : m[3] === 'png' ? 'image/png' : 'model/gltf-binary');
      res.setHeader('Content-Length', String(st.size));
      res.setHeader('Cache-Control', 'max-age=3600');
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  };
  return {
    name: 'game-assets',
    configureServer(server) {
      server.middlewares.use('/game', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/game', handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), devSave(), gameAssets()],
  server: { port: 5177, strictPort: true },
  test: { environment: 'node' },
});
