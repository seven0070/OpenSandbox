/**
 * srv/serve.mjs — a whole server, on purpose, and small on purpose too.
 *
 * No framework and no build step: ~90 lines of Node. The reason is portability —
 * `cp -R` this folder anywhere with a static file server and the world is
 * identical, because there is exactly one copy of the laws and nothing between
 * it and the browser.
 *
 * Two additions over a plain static server, both in service of "the universe
 * shapes to what I want":
 *
 *   POST /universe.json   save the current charter (what you created) to disk
 *   GET  /events          Server-Sent Events; the page reloads the universe
 *                         whenever universe.json changes on disk — including
 *                         when *you* edit it, or an agent writes it. The file is
 *                         the interface: shape a world in a text editor, or from
 *                         a chat message, and the running page follows.
 */
import { createServer } from 'node:http';
import { stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync, watch as fsWatch } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CHARTER = join(ROOT, 'universe.json');
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

// --- live shaping: an SSE channel that announces charter changes -------------
const clients = new Set();
function broadcast(text, event = 'charter') {
  const payload = `event: ${event}\ndata: ${JSON.stringify(text).slice(1, -1).replace(/\n/g, '\\n')}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

/* Watching the DIRECTORY and filtering on the filename is deliberate. The first
 * version used `watch` from node:fs/promises — which returns an async iterator,
 * not a promise — so its re-arm path threw `watch(...).then is not a function`
 * the moment universe.json was deleted, and took the whole server down. A file
 * watcher has to survive its own file disappearing, because "back to the void"
 * is a thing you are allowed to do here. */
let fsWatcher = null;
function armCharterWatch() {
  if (fsWatcher) return;
  try {
    fsWatcher = fsWatch(ROOT, (_event, filename) => {
      if (!filename || filename.toString() !== 'universe.json') return;
      readFile(CHARTER, 'utf8')
        .then((body) => {
          broadcast(body);
          console.log(`[arcane] universe.json changed on disk → pushed to ${clients.size} client(s)`);
        })
        .catch(() => {
          broadcast('');
          console.log(`[arcane] universe.json removed → pushed the void to ${clients.size} client(s)`);
        });
    });
    fsWatcher.on('error', () => { fsWatcher = null; });
  } catch {
    fsWatcher = null; // no directory to watch; POST re-arms after the first save
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path === '/' || path === '') path = '/index.html';

  if (path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write('retry: 1500\n\n');
    if (existsSync(CHARTER)) res.write(`event: charter\ndata: ${JSON.stringify(await readFile(CHARTER, 'utf8')).slice(1, -1)}\n\n`);
    else res.write('event: charter\ndata: {"empty":true}\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && path === '/universe.json') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      JSON.parse(body); // refuse to write a charter the loader could not read
    } catch (e) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`refused: not valid JSON (${e.message})`);
      return;
    }
    await writeFile(CHARTER, body);
    broadcast(body);
    armCharterWatch();
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify({ ok: true, bytes: body.length }));
    console.log(`[arcane] charter saved (${body.length} bytes) → ${clients.size} client(s) notified`);
    return;
  }

  if (req.method === 'GET' && path === '/universe.json' && !existsSync(CHARTER)) {
    // The void is a real state, so "no file" answers as "no file", not 404 noise
    // in the console: the page treats it as an empty universe.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('');
    return;
  }

  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const info = await stat(file);
    if (info.isDirectory()) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
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
  console.log(`[arcane] http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/  (the void)`);
  console.log(`[arcane] http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/archipelago.html  (a created world)`);
  armCharterWatch();
});
