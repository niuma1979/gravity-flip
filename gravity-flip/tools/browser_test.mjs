'use strict';
/* =========================================================================
 * 真实浏览器验证（Chrome + DevTools Protocol，无需任何 npm 依赖）
 *
 * 为什么要做：node --check 只能证明语法对，无头 DOM 桩只能证明逻辑不炸。
 * 只有真浏览器能证明：内联脚本能执行、canvas 真的画出了东西、按键真的能
 * 驱动游戏、没有任何未捕获异常。
 *
 * 用法: node tools/browser_test.mjs
 * 产出: verify/browser-report.json + verify/screenshot-*.png
 * ========================================================================= */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const distPath = path.join(root, 'dist', 'gravity-flip.html');
const userDir = path.join(root, '.chrome-profile');
const reportDir = path.join(root, 'verify');
const PORT = 9333;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

if (!CHROME) { console.log('SKIP: 找不到 Chrome/Edge'); process.exit(2); }
if (!fs.existsSync(distPath)) { console.log('FAIL: 找不到 ' + distPath); process.exit(1); }

fs.mkdirSync(reportDir, { recursive: true });
fs.rmSync(userDir, { recursive: true, force: true });
fs.mkdirSync(userDir, { recursive: true });

const fileUrl = 'file:///' + distPath.replace(/\\/g, '/');
// 注意：headless 模式不支持「启动参数里同时给 url + 调试端口」这种多目标形式，
// 所以先开一个空白页，再通过 CDP 的 Page.navigate 打开产物。
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--no-sandbox',
  '--disable-crash-reporter',
  '--user-data-dir=' + userDir,
  '--remote-debugging-port=' + PORT,
  '--window-size=1280,800',
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools 端点未就绪');
}

/* 极简 CDP 客户端（Node 内置 WebSocket，无需 ws 包） */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        c.events.push(msg);
      }
    });
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}

let cdp = null;
try {
  const wsUrl = await getWsUrl();
  cdp = await CDP.connect(wsUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.navigate', { url: fileUrl });
  await sleep(1500);

  const pageErrors = [];
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails.text + ' ' +
        ((m.params.exceptionDetails.exception || {}).description || ''));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      pageErrors.push('console.error: ' + m.params.entry.text);
    }
  });

  // 1) 页面基本状态
  const title = await cdp.eval('document.title');
  check('页面标题正确', title.includes('重力反转'), title);

  const levelCount = await cdp.eval('(window.GF_GAME && window.GF_GAME.LEVELS.length) || 0');
  check('页面内加载了 12 关', levelCount === 12, 'LEVELS=' + levelCount);

  const mode = await cdp.eval('window.GF_GAME && window.GF_GAME.Game.mode');
  check('初始进入菜单状态', mode === 'menu', mode);

  const overlayVisible = await cdp.eval('!document.getElementById("overlay").hidden');
  check('菜单覆盖层可见', overlayVisible === true, overlayVisible);

  // 2) canvas 真的画了东西（取像素统计）
  const pixelStats = await cdp.eval(`(() => {
    const c = document.getElementById('game');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      const lum = d[i] + d[i+1] + d[i+2];
      sum += lum;
      if (lum > 60) nonBg++;
    }
    return { nonBg, sampled: Math.floor(d.length / (4 * 97)), sum };
  })()`);
  check('canvas 有实际绘制内容', pixelStats.nonBg > pixelStats.sampled * 0.02,
    '非背景采样 ' + pixelStats.nonBg + '/' + pixelStats.sampled);

  // 3) 真实键盘输入驱动游戏
  await cdp.eval('window.GF_GAME.startLevel(0)');
  await sleep(200);
  const before = await cdp.eval('({x: window.GF_GAME.Game.sim.dyn.px, t: window.GF_GAME.Game.sim.time})');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(900);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 });
  const after = await cdp.eval('({x: window.GF_GAME.Game.sim.dyn.px, t: window.GF_GAME.Game.sim.time, flips: window.GF_GAME.Game.sim.dyn.flipCount})');
  check('真实按键能驱动玩家移动', after.x - before.x > 50, 'x ' + Math.round(before.x) + ' -> ' + Math.round(after.x));

  // 4) 真实按键触发重力翻转
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyZ', key: 'z', windowsVirtualKeyCode: 90 });
  await sleep(60);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyZ', key: 'z', windowsVirtualKeyCode: 90 });
  await sleep(700);
  const afterFlip = await cdp.eval('({g: window.GF_GAME.Game.sim.dyn.gravity, flips: window.GF_GAME.Game.sim.dyn.flipCount, y: window.GF_GAME.Game.sim.dyn.py})');
  check('真实按键 Z 能翻转重力', afterFlip.g === -1 && afterFlip.flips === 1,
    'gravity=' + afterFlip.g + ' flips=' + afterFlip.flips);
  check('翻转后玩家飞向天花板', afterFlip.y < 400, 'y=' + Math.round(afterFlip.y));

  // 5) HUD 真的更新
  const hud = await cdp.eval('({level: document.getElementById("level").textContent, time: document.getElementById("time").textContent, flips: document.getElementById("flips").textContent})');
  check('HUD 关卡显示为 1 / 12', hud.level.trim() === '1 / 12', hud.level);
  check('HUD 翻转计数已更新', hud.flips.trim() === '1', hud.flips);
  check('HUD 时间已计时', parseFloat(hud.time) > 0.3, hud.time);

  // 6) 暂停 / 重开
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyP', key: 'p', windowsVirtualKeyCode: 80 });
  await sleep(250);
  const paused = await cdp.eval('window.GF_GAME.Game.mode');
  check('真实按键 P 能暂停', paused === 'pause', paused);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyR', key: 'r', windowsVirtualKeyCode: 82 });
  await sleep(250);
  const restarted = await cdp.eval('({mode: window.GF_GAME.Game.mode, time: window.GF_GAME.Game.sim.time})');
  check('真实按键 R 能重开本关', restarted.mode === 'play' && restarted.time === 0,
    'mode=' + restarted.mode + ' time=' + restarted.time);

  // 7) 逐关都能在真浏览器里启动并渲染
  const allLevels = await cdp.eval(`(() => {
    const G = window.GF_GAME;
    const bad = [];
    for (let i = 0; i < G.LEVELS.length; i++) {
      try { G.startLevel(i); if (G.Game.mode !== 'play') bad.push(i + 1 + ':mode=' + G.Game.mode); }
      catch (e) { bad.push(i + 1 + ':' + e.message); }
    }
    return bad;
  })()`);
  check('12 关在真浏览器里都能启动', allLevels.length === 0, allLevels.join('; ') || '全部正常');

  // 8) 截图
  await cdp.eval('window.GF_GAME.startLevel(0)');
  await sleep(400);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(reportDir, 'screenshot-level1.png'), Buffer.from(shot.data, 'base64'));
  await cdp.eval('window.GF_GAME.startLevel(6)');
  await sleep(400);
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(reportDir, 'screenshot-level7.png'), Buffer.from(shot2.data, 'base64'));
  check('截图已保存', true, 'verify/screenshot-level1.png, verify/screenshot-level7.png');

  // 9) 页面异常
  await sleep(400);
  check('无未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '无');

} catch (e) {
  check('浏览器测试执行完成', false, e.message);
} finally {
  try { if (cdp) cdp.ws.close(); } catch (e) { /* ignore */ }
  try { chrome.kill(); } catch (e) { /* ignore */ }
  await sleep(400);
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(reportDir, 'browser-report.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), chrome: CHROME, dist: distPath, results, failed: failed.length }, null, 2));

console.log('\n浏览器验证: ' + (results.length - failed.length) + ' PASS / ' + failed.length + ' FAIL');
process.exit(failed.length ? 1 : 0);
