/**
 * srv/serve.mjs — a whole server, on purpose.
 *
 * No framework, no build step, no bundler: ~60 lines of Node serving static
 * files with correct MIME types for ES modules. The reason this project has no
 * build step is portability: `cp -R sandbox-world anywhere && python3 -m
 * http.server` gives you the identical world. What you test in Node is what
 * runs in the browser, byte for byte, because there is exactly one copy of the
 * laws and nothing between it and you.
 */
import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path === '/' || path === '') path = '/index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      // ES modules are fetched with CORS-ish strictness; keep it permissive so
      // the folder can also be opened from file:// or a subpath on any host.
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${path}: ${e.code ?? e.message}\nroot: ${ROOT}\n`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[arcane] serving ${ROOT}`);
  console.log(`[arcane] http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
});
