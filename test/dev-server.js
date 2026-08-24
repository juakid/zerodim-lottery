'use strict';

/**
 * 本地预览服务器（可选，零依赖）
 *
 * 在没有 netlify-cli 的环境下快速预览：
 *   用法: node test/dev-server.js   （默认 http://127.0.0.1:8888）
 * 模拟 netlify.toml 的两件事：
 *   1. /api/* 重定向到统一函数入口（api.js handler）
 *   2. 静态安全响应头
 *
 * 正式本地开发请使用: npm run dev （netlify dev，功能更完整）。
 * 数据存储：与函数一致（优先 Netlify Blobs；不可用时回退 .data/ 本地文件）。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8888);

const { handler } = require('../netlify/functions/api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 与 netlify.toml 保持一致的静态安全响应头
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Cache-Control': 'public, max-age=0, must-revalidate',
};

function serveStatic(req, res, urlPath) {
  let filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (urlPath === '/' || urlPath === '') filePath = path.join(ROOT, 'index.html');
  if (!path.extname(filePath)) filePath = path.join(filePath, 'index.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const body = await readBody(req);
      const event = {
        httpMethod: req.method,
        path: url.pathname,
        rawUrl: `http://${req.headers.host || 'localhost'}${req.url}`,
        headers: {
          cookie: req.headers.cookie || '',
          'x-forwarded-proto': 'http',
          'x-forwarded-for': req.socket.remoteAddress || '',
          'x-nf-client-connection-ip': req.socket.remoteAddress || '',
          'content-type': req.headers['content-type'] || '',
        },
        body: body || null,
        queryStringParameters: Object.fromEntries(url.searchParams.entries()),
      };
      const result = await handler(event);
      const headers = { ...result.headers };
      if (headers['Set-Cookie']) {
        // 一个响应可能包含多个 Set-Cookie（本应用不会），单值直接透传
        headers['Set-Cookie'] = headers['Set-Cookie'];
      }
      res.writeHead(result.statusCode, headers);
      res.end(result.body);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[dev-server] 请求处理失败:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INTERNAL', message: '服务器开小差了' }));
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-server] 本地预览: http://127.0.0.1:${PORT}  (静态文件 + /api/* 路由)`);
});
