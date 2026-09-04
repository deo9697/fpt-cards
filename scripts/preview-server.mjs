import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
const listenHost = '0.0.0.0';
const host = 'localhost';
const port = Number(process.env.FPT_PREVIEW_PORT || 8080);
const mime = {
  '.css':'text/css; charset=utf-8', '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json',
  '.woff2':'font/woff2', '.mp3':'audio/mpeg', '.mp4':'video/mp4'
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${host}:${port}`);
    const relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const body = await fs.readFile(target);
    response.setHeader('Content-Type', mime[path.extname(target).toLowerCase()] || 'application/octet-stream');
    response.setHeader('Cache-Control', relative === 'sw.js' ? 'no-store' : 'no-cache');
    response.end(body);
  } catch (error) {
    response.writeHead(error?.code === 'ENOENT' ? 404 : 500).end(error?.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
});

server.listen(port, listenHost, () => {
  console.log(`FPT Cards disponibile su http://localhost:${port}`);
  const lanAddresses = Object.values(os.networkInterfaces()).flat()
    .filter(item => item && item.family === 'IPv4' && !item.internal)
    .map(item => item.address);
  for (const address of lanAddresses) console.log(`Da un altro dispositivo sulla stessa rete (es. telefono): http://${address}:${port}`);
});
