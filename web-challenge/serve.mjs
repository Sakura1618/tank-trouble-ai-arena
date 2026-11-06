import { createReadStream, watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { build, distDir, projectDir, publicFiles, kitFiles } from './build.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const host = option('--host', '127.0.0.1');
const port = Number(option('--port', '5173'));
const development = args.includes('--dev');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.zip': 'application/zip' };

try {
  if (development) await build();
  else await stat(resolve(distDir, 'index.html'));
} catch (error) {
  console.error(`无法启动网页：${error.message}\n请先运行 npm run build，或使用 npm run dev。`);
  process.exit(1);
}

const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  let file;
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    file = resolve(distDir, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
    const location = relative(distDir, file);
    if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) {
      response.writeHead(403); response.end('禁止访问'); return;
    }
    const info = await stat(file);
    if (!info.isFile()) { response.writeHead(404); response.end('文件不存在'); return; }
    response.writeHead(200, {
      'Content-Type': types[extname(file)] || 'text/plain; charset=utf-8',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...(file === resolve(distDir, 'AI_Starter_Kit.zip') ? { 'Content-Disposition': 'attachment; filename="AI_Starter_Kit.zip"' } : {}),
      ...(file === resolve(distDir, 'AI_Training_Arena_Windows_x64.zip') ? { 'Content-Disposition': 'attachment; filename="AI_Training_Arena_Windows_x64.zip"' } : {}),
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).on('error', () => response.destroy()).pipe(response);
  } catch (error) {
    response.writeHead(error instanceof URIError ? 400 : 404);
    response.end('文件不存在或地址无效');
  }
});

server.on('error', error => { console.error(`静态服务器启动失败：${error.message}`); process.exitCode = 1; });
server.listen(port, host, () => {
  console.log(`坦克挑战网页：http://localhost:${port}/\n仅提供静态目录：${distDir}`);
  if (host === '0.0.0.0' || host === '::') {
    for (const info of Object.values(networkInterfaces()).flat()) {
      if (info.family === 'IPv4' && !info.internal) console.log(`手机同一局域网访问：http://${info.address}:${port}/`);
    }
  }
  console.log(development ? '开发模式：源码保存后自动重新构建，浏览器手动刷新。Ctrl+C 结束。' : '静态服务器已启动。Ctrl+C 结束。');
});

if (development) {
  // 仅监听发布依赖和明确批准的 AI，不扫描私有训练资料。
  const watchers = new Map();
  let rebuilding = false;
  let requested = false;
  async function rebuild() {
    requested = true;
    if (rebuilding) return;
    rebuilding = true;
    while (requested) {
      requested = false;
      try { await build(); await refreshWatchers(); }
      catch (error) { console.error(`重新构建失败：${error.message}`); }
    }
    rebuilding = false;
  }
  async function refreshWatchers() {
    const roster = JSON.parse(await readFile(resolve(projectDir, 'presets.json'), 'utf8'));
    const files = [...publicFiles, ...kitFiles, 'index.html', 'presets.json',
      ...roster.filter(entry => entry.script).map(entry => entry.script)];
    const directories = new Map();
    for (const file of files) {
      const path = resolve(projectDir, file);
      const directory = dirname(path);
      if (!directories.has(directory)) directories.set(directory, new Set());
      directories.get(directory).add(path);
    }
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    for (const [directory, paths] of directories) {
      watchers.set(directory, watch(directory, (_event, filename) => {
        if (filename && paths.has(resolve(directory, filename.toString()))) void rebuild();
      }));
    }
  }
  await refreshWatchers();
}
