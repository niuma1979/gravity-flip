'use strict';
/* =========================================================================
 * 局域网分享小工具：把 dist/ 用静态服务跑起来，并打印可直接发到 QQ 的地址。
 *
 * 用途：不想部署到公网时，让同一个 WiFi 下的朋友/自己的手机先玩上。
 *      （注意：局域网地址只有同一网络内能访问，发给外网朋友打不开）
 *
 * 用法: node tools/share_lan.mjs [端口]
 * ========================================================================= */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');
const PORT = Number(process.argv[2] || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/gravity-flip.html';
  const filePath = path.join(dist, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(dist)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('404 找不到: ' + urlPath); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
});

function lanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address });
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('局域网分享服务已启动（Ctrl+C 停止）\n');
  console.log('本机自测:      http://127.0.0.1:' + PORT + '/');
  if (!ips.length) {
    console.log('没有检测到局域网 IP，手机可能无法访问。');
  } else {
    for (const ip of ips) {
      console.log('同 WiFi 分享:  http://' + ip.address + ':' + PORT + '/    （网卡 ' + ip.name + '）');
    }
    console.log('\n把上面「同 WiFi 分享」那条链接发到 QQ，同一 WiFi 下的手机点开就能玩。');
  }
  console.log('\n提醒：这个地址只有同一个局域网能访问；要给外网朋友玩，请部署到公网（见 SHARE.md）。');
});
