'use strict';
/* =========================================================================
 * 无头运行时冒烟测试：用最小 DOM 桩在 node 里真正跑一遍 js/game.js。
 *
 * 语法检查（node --check）抓不到的运行时错误（拼写、undefined、null.id 之类）
 * 靠这里暴露。渲染用假的 2D context，只记录调用次数。
 *
 * 用法: node tools/smoke_test.mjs [关卡号]
 * ========================================================================= */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/* ------------------------------ DOM 桩 ------------------------------ */
const created = [];
function makeCtx2d() {
  const calls = { count: 0 };
  const noop = () => { calls.count++; };
  const grad = { addColorStop: noop };
  const ctx = {
    calls,
    canvas: null,
    setTransform: noop, clearRect: noop, save: noop, restore: noop, translate: noop,
    rotate: noop, scale: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, arcTo: noop, rect: noop, fill: noop, stroke: noop, fillRect: noop,
    strokeRect: noop, drawImage: noop, fillText: noop, measureText: () => ({ width: 10 }),
    createRadialGradient: () => grad, createLinearGradient: () => grad,
    set fillStyle(v) { calls.count++; }, get fillStyle() { return '#000'; },
    set strokeStyle(v) { calls.count++; }, get strokeStyle() { return '#000'; },
    set lineWidth(v) {}, set globalAlpha(v) {}, get globalAlpha() { return 1; },
    set shadowColor(v) {}, set shadowBlur(v) {}, set font(v) {},
    imageSmoothingEnabled: true
  };
  return ctx;
}

function makeElement(id, tag) {
  const el = {
    id, tagName: (tag || 'div').toUpperCase(),
    children: [], attrs: {}, style: {}, dataset: {}, listeners: {},
    _text: '', _html: '', hidden: false, disabled: false, classList: null,
    getContext: () => el._ctx || (el._ctx = makeCtx2d()),
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k] === undefined ? null : el.attrs[k]; },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); return c; },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, ev) { (el.listeners[type] || []).forEach((fn) => fn(ev || { preventDefault() {}, stopPropagation() {} })); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    focus() {}, blur() {}, click() { el.dispatch('click'); },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 })
  };
  el.classList = {
    _s: new Set(),
    add(c) { el.classList._s.add(c); },
    remove(c) { el.classList._s.delete(c); },
    contains(c) { return el.classList._s.has(c); },
    toggle(c) { if (el.classList._s.has(c)) el.classList._s.delete(c); else el.classList._s.add(c); }
  };
  Object.defineProperty(el, 'textContent', { get: () => el._text, set: (v) => { el._text = String(v); } });
  Object.defineProperty(el, 'innerHTML', { get: () => el._html, set: (v) => { el._html = String(v); el.children = []; } });
  created.push(el);
  return el;
}

const byId = {};
for (const id of ['level', 'time', 'flips', 'stars', 'hint', 'overlay', 'overlay-title',
  'overlay-body', 'overlay-buttons', 'game', 'pad', 'wrap', 'hud']) {
  byId[id] = makeElement(id, id === 'game' ? 'canvas' : (id === 'pad' ? 'nav' : 'div'));
}
byId.overlay.hidden = true;
byId.pad.querySelectorAll = () => ['left', 'right', 'jump', 'flip'].map((a) => {
  const b = makeElement('btn-' + a, 'button');
  b.setAttribute('data-action', a);
  return b;
});

const documentStub = {
  readyState: 'complete',
  hidden: false,
  getElementById: (id) => byId[id] || null,
  createElement: (tag) => makeElement('created-' + tag, tag),
  addEventListener() {},
  querySelectorAll: () => [],
  body: makeElement('body', 'body'),
  documentElement: makeElement('html', 'html')
};

const frameCallbacks = [];
const windowStub = {
  document: documentStub,
  devicePixelRatio: 1,
  addEventListener(type, fn) { (this._l = this._l || {})[type] = (this._l[type] || []).concat([fn]); },
  removeEventListener() {},
  requestAnimationFrame(fn) { frameCallbacks.push(fn); return frameCallbacks.length; },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  },
  AudioContext: null,
  navigator: { userAgent: 'node-smoke-test' },
  innerWidth: 1280,
  innerHeight: 720
};

/* --------------------------- 注入并加载 --------------------------- */
const errors = [];
global.window = windowStub;
global.document = documentStub;
global.localStorage = windowStub.localStorage;
global.requestAnimationFrame = windowStub.requestAnimationFrame;
global.devicePixelRatio = 1;
global.addEventListener = windowStub.addEventListener.bind(windowStub);
try { Object.defineProperty(global, 'navigator', { value: windowStub.navigator, configurable: true }); }
catch (e) { /* node 自带只读 navigator，无所谓 */ }

const origError = console.error;
console.error = (...a) => { errors.push(a.join(' ')); origError.apply(console, a); };

function load(file) {
  const full = path.join(root, file);
  const src = require('node:fs').readFileSync(full, 'utf8');
  try {
    // 用 Function 在注入的全局里执行（等价于浏览器里的 <script>）
    // eslint-disable-next-line no-new-func
    new Function(src)();
  } catch (e) {
    errors.push('加载 ' + file + ' 失败: ' + e.stack);
  }
}

/* ---- 验证方注入：加载 dist 产物的内联脚本，而不是 js/ 源文件 ---- */
const fsx = require('node:fs');
const distHtml = fsx.readFileSync(path.join(root, 'dist', 'gravity-flip.html'), 'utf8');
const bm = distHtml.match(/<script>\n([\s\S]*?)\n<\/script>/);
if (!bm) { errors.push('无法从 dist 产物中抽出内联脚本'); }
else {
  try { new Function(bm[1])(); } catch (e) { errors.push('加载 dist 内联脚本失败: ' + e.stack); }
}
console.log('== 本次运行加载的是 dist/gravity-flip.html 的内联脚本（' + (bm ? bm[1].length : 0) + ' 字符），不是 js/ 源文件 ==');

const G = windowStub.GF_GAME;
const P = windowStub.GF_PHYSICS;

/* ------------------------------ 断言 ------------------------------ */
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('PASS  ' + msg); }
  else { fail++; console.log('FAIL  ' + msg); }
}

ok(!!P, 'physics 已挂载到 window.GF_PHYSICS');
ok(!!windowStub.GF_LEVELS_1_6, 'levels.js 已挂载 GF_LEVELS_1_6');
ok(!!windowStub.GF_LEVELS_7_12, 'levels7-12.js 已挂载 GF_LEVELS_7_12');
ok(!!G, 'game.js 已挂载 window.GF_GAME（未抛异常）');
ok(errors.length === 0, 'game.js 加载期间 console.error 为 0 次（实际 ' + errors.length + '）');

if (G) {
  ok(G.LEVELS.length === 12, '共 12 关（实际 ' + G.LEVELS.length + '）');
  const ids = G.LEVELS.map((l) => l.id);
  ok(ids.join(',') === '1,2,3,4,5,6,7,8,9,10,11,12', '关卡 id 连续 1..12（实际 ' + ids.join(',') + '）');
  ok(G.Game.mode === 'menu', '初始状态为 menu（实际 ' + G.Game.mode + '）');

  const titles = byId['overlay-title'].textContent;
  ok(titles.length > 0, '菜单覆盖层有标题: "' + titles + '"');
  ok(byId['overlay'].hidden === false, '菜单覆盖层可见');

  // 逐关启动，检查 compile + 建缓存 + HUD
  let startFails = [];
  for (let i = 0; i < G.LEVELS.length; i++) {
    try {
      G.startLevel(i);
      if (G.Game.mode !== 'play') startFails.push(i + 1 + ':mode=' + G.Game.mode);
      if (!G.Game.sim) startFails.push(i + 1 + ':无 sim');
    } catch (e) { startFails.push(i + 1 + ':' + e.message); }
  }
  ok(startFails.length === 0, '逐关 startLevel 全部成功' + (startFails.length ? ' -> ' + startFails.join('; ') : ''));

  // 模拟按键 + 渲染若干帧（直接调用 rAF 回调）
  G.startLevel(0);
  const sim = G.Game.sim;
  const dt = 1000 / 60;
  let pump = 0;                 // 全局单调递增的 rAF 时间戳
  G.keys.right = true;
  console.log('  [debug] mode=' + G.Game.mode + ' keys=' + JSON.stringify(G.keys) +
    ' start=' + Math.round(sim.dyn.px) + ',' + Math.round(sim.dyn.py) +
    ' grounded=' + sim.dyn.grounded);
  let frames = 0, renderErr = null;
  try {
    // 推进 rAF 回调 240 帧（约 4 秒）
    for (let i = 0; i < 240; i++) {
      pump += dt;
      const cbs = frameCallbacks.splice(0, frameCallbacks.length);
      for (const cb of cbs) cb(pump);
      frames++;
    }
  } catch (e) { renderErr = e.stack; }
  ok(renderErr === null, '渲染/更新 240 帧无异常' + (renderErr ? ' -> ' + renderErr : ''));
  ok(frames === 240, '帧回调被调用 ' + frames + ' 次');
  ok(sim.dyn.px > 400, '按住右键 4 秒能沿地面走到 x>400（x=' + Math.round(sim.dyn.px) + '）');
  ok(!sim.dyn.dead, '地面正常行走不会死亡');

  // 起跳后确实离地
  G.startLevel(0);
  for (let i = 0; i < 30; i++) { G.keys.right = true; }
  G.keys.jump = true;
  const s2 = G.Game.sim;
  const y0 = s2.dyn.py;
  let maxUp = 0;
  let ts2 = 0;
  for (let i = 0; i < 40; i++) {
    ts2 += dt;
    let advance = 0;
    const cbs = frameCallbacks.splice(0, frameCallbacks.length);
    pump += dt;  // 时间戳必须单调递增，否则 dt 变负
    for (const cb of cbs) cb(pump);
    maxUp = Math.max(maxUp, y0 - s2.dyn.py);
  }
  ok(maxUp > 60, '跳跃能上升超过 60px（实测 ' + Math.round(maxUp) + 'px）');
  console.log('  [debug] jump: py=' + Math.round(s2.dyn.py) + ' vy=' + Math.round(s2.dyn.vy) +
    ' grounded=' + s2.dyn.grounded + ' mode=' + G.Game.mode + ' keys=' + JSON.stringify(G.keys));

  // 翻转后重力方向反转
  G.startLevel(0);
  const s3 = G.Game.sim;
  const kd0 = (windowStub._l && windowStub._l.keydown) || [];
  kd0.forEach((h) => h({ code: 'KeyZ', repeat: false, preventDefault() {} }));
  for (let i = 0; i < 90; i++) {           // 90 帧足够飞上去并稳定贴住天花板
    pump += dt;
    const cbs = frameCallbacks.splice(0, frameCallbacks.length);
    for (const cb of cbs) cb(pump);
  }
  ok(s3.dyn.gravity === -1, '按 Z 后重力方向翻转为 -1（实际 ' + s3.dyn.gravity + '）');
  ok(s3.dyn.py < 300, '翻转后玩家飞向天花板（y=' + Math.round(s3.dyn.py) + '）');
  ok(s3.dyn.grounded === true, '稳定后玩家贴在天花板上（grounded=true）');

  // 行为验证：还能从天花板再次起跳
  const yCeil = s3.dyn.py;
  kd0.forEach((h) => h({ code: 'Space', repeat: false, preventDefault() {} }));
  for (let i = 0; i < 8; i++) {
    pump += dt;
    const cbs = frameCallbacks.splice(0, frameCallbacks.length);
    for (const cb of cbs) cb(pump);
  }
  ok(Math.abs(s3.dyn.py - yCeil) > 15,
    '能从天花板再次起跳（位移 ' + Math.round(Math.abs(s3.dyn.py - yCeil)) + 'px, vy=' + Math.round(s3.dyn.vy) + '）');

  // HUD 是否随状态更新
  ok(byId['time'].textContent !== '0.0', 'HUD 时间已开始计时: ' + byId['time'].textContent);
  ok(/^\d+ \/ 12$/.test(byId['level'].textContent), 'HUD 关卡格式正确: ' + byId['level'].textContent);
  ok(/^\d+ \/ 3$/.test(byId['stars'].textContent), 'HUD 星星格式正确: ' + byId['stars'].textContent);

  // 暂停 / 恢复
  windowStub.dispatchKey = null;
  try {
    G.startLevel(0);
    // 直接调用内部键盘处理：通过 window.addEventListener 捕获的 handler
    const kd = (windowStub._l && windowStub._l.keydown) || [];
    ok(kd.length > 0, '已注册 keydown 处理器');
    const ev = { code: 'KeyP', repeat: false, preventDefault() {} };
    kd.forEach((h) => h(ev));
    ok(G.Game.mode === 'pause', '按 P 进入暂停（实际 ' + G.Game.mode + '）');
    kd.forEach((h) => h({ code: 'KeyP', repeat: false, preventDefault() {} }));
    ok(G.Game.mode === 'play', '再按 P 恢复（实际 ' + G.Game.mode + '）');
    kd.forEach((h) => h({ code: 'KeyR', repeat: false, preventDefault() {} }));
    ok(G.Game.mode === 'play' && G.Game.sim.time === 0, '按 R 重开本关且计时归零');
  } catch (e) {
    ok(false, '暂停/恢复流程异常: ' + e.message);
  }

  // 三星与存档
  try {
    G.startLevel(0);
    const s = G.Game.sim;
    s.dyn.won = true;
    s.time = 1;
    s.dyn.flipCount = 1;
    s.dyn.starsTaken = 3;
    const stars = P.rateLevel(s);
    ok(stars === 3, 'rateLevel 在 par 内给 3 星（实际 ' + stars + '）');
    s.time = 9999; s.dyn.flipCount = 999;
    ok(P.rateLevel(s) === 1, 'rateLevel 超 par 只给 1 星（实际 ' + P.rateLevel(s) + '）');
  } catch (e) { ok(false, 'rateLevel 异常: ' + e.message); }

  // 端到端：真的通关一次，检查结算覆盖层 + 存档 + 解锁
  try {
    G.startLevel(0);
    const s4 = G.Game.sim;
    const saveBefore = JSON.parse(JSON.stringify(G.save));
    // 直接把「已集齐 3 星 + 站在出口上」的状态摆好，让真正的游戏循环去判定通关
    s4.stars.forEach((st) => { st.taken = true; });
    s4.dyn.starsTaken = 3;
    s4.dyn.px = s4.L.exit.x;
    s4.dyn.py = s4.L.exit.y;
    s4.time = 2;
    s4.dyn.flipCount = 1;
    for (let i = 0; i < 5; i++) {
      pump += dt;
      const cbs = frameCallbacks.splice(0, frameCallbacks.length);
      for (const cb of cbs) cb(pump);
    }
    ok(G.Game.mode === 'clear', '通关后进入结算状态（实际 ' + G.Game.mode + '）');
    ok(byId['overlay'].hidden === false, '通关后结算覆盖层可见');
    const title = byId['overlay-title'].textContent;
    ok(/通过|通关/.test(title), '结算标题正确: "' + title + '"');
    const body = byId['overlay-body'].innerHTML;
    ok(body.includes('★'), '结算内容包含星级图标');
    ok(body.includes('par'), '结算内容显示 par 阈值');
    ok(byId['overlay-buttons'].children.length > 0, '结算界面有按钮（下一关/重玩）');
    const saved = G.bestOf(1);
    ok(saved.stars === 3, '三星成绩已写入存档（stars=' + saved.stars + '）');
    ok((G.save.unlocked || 1) >= 2, '通关后解锁了第 2 关（unlocked=' + G.save.unlocked + '）');
    ok(G.save.unlocked >= saveBefore.unlocked, '解锁进度只增不减');
    ok(windowStub.localStorage.getItem('gravity-flip-save-v2') !== null, '存档写入了 localStorage[gravity-flip-save-v2]');
  } catch (e) { ok(false, '端到端通关流程异常: ' + e.stack); }
}

/* ------------------------------ 汇总 ------------------------------ */
console.log('\n无头冒烟测试: ' + pass + ' PASS / ' + fail + ' FAIL');
if (errors.length) {
  console.log('\n捕获到的运行时错误:');
  errors.slice(0, 10).forEach((e) => console.log('  - ' + e));
}
process.exit(fail ? 1 : 0);
