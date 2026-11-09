import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/**
 * Только для разработки: страница калибровки (tools/calibrate) сохраняет
 * результаты рендера морфов на диск через POST /__save?file=...
 * Разрешены пути внутри tools/local и src/data.
 */
function devSave(): Plugin {
  return {
    name: 'dev-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save', (req, res) => {
        const url = new URL(req.url ?? '', 'http://x');
        const rel = url.searchParams.get('file') ?? '';
        const abs = path.resolve(root, rel);
        const okDirs = [path.resolve(root, 'tools/local'), path.resolve(root, 'src/data')];
        if (req.method !== 'POST' || !okDirs.some((d) => abs.startsWith(d + path.sep))) {
          res.statusCode = 400;
          res.end('bad path');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          let body = Buffer.concat(chunks);
          if (rel.endsWith('.png')) body = Buffer.from(body.toString('utf8').replace(/^data:image\/png;base64,/, ''), 'base64');
          fs.writeFileSync(abs, body);
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devSave()],
  server: { port: 5177, strictPort: true },
  test: { environment: 'node' },
});
