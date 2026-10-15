'use strict';
/* =========================================================================
 * 逐关「卡角/瞬移」回归测试。
 *
 * 背景：玩家 AABB 是 24x28，而格子 40px，出生点很容易与墙/平台「部分重叠」。
 * 早期版本在这种情况下会一帧内被水平弹回 40px，形成左右横跳的死循环
 * （看起来像原地抽搐）。这个测试对 12 关逐一模拟长按左/右，断言玩家真的
 * 在移动，而不是被卡住或瞬移。
 *
 * 用法: node tools/regress_corner.mjs [--verbose]
 * ========================================================================= */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const P = require(path.join(root, 'js', 'physics.js'));
const { LEVELS_1_6 } = require(path.join(root, 'js', 'levels.js'));
let L7 = [];
try { L7 = require(path.join(root, 'js', 'levels7-12.js')).LEVELS_7_12 || []; } catch (e) { /* 可选 */ }
const ALL = LEVELS_1_6.concat(L7).sort((a, b) => a.id - b.id);
const DT = P.PHYS.DT;
const FRAMES = 240;               // 4 秒

let fails = 0;
const verbose = process.argv.includes('--verbose');

function run(level, keys, frames, hook) {
  const L = P.compileLevel(level);
  const s = P.createSim(L);
  let maxReach = Math.abs(L.spawn.x - L.spawn.x);
  let teleports = 0;
  let stopped = false;
  let prev = { x: s.dyn.px, y: s.dyn.py };
  for (let i = 0; i < frames; i++) {
    P.stepSim(s, keys, DT);
    if (hook) hook(s, i);
    if (s.dyn.dead || s.dyn.failed) { stopped = true; break; }   // 死亡重生会瞬移，属于正常
    const dx = Math.abs(s.dyn.px - prev.x);
    const dy = Math.abs(s.dyn.py - prev.y);
    if (dx > 60 || dy > 60) teleports++;   // 单帧位移超过 1.5 格 = 真瞬移
    maxReach = Math.max(maxReach, Math.abs(s.dyn.px - L.spawn.x));
    prev = { x: s.dyn.px, y: s.dyn.py };
  }
  return { s, maxReach, teleports, L, stopped };
}

console.log('== 逐关长按方向键：是否真的在移动（而非卡角/瞬移）==');
console.log('   （朝向墙壁走不动是正常的；只要有一侧能走开就说明没卡死在角里）');
for (const lv of ALL) {
  const results = [];
  for (const dir of ['right', 'left']) {
    const keys = dir === 'right' ? { right: true } : { left: true };
    const r = run(lv, keys, FRAMES);
    results.push({ dir, ...r });
  }
  const best = Math.max(...results.map((r) => r.maxReach));
  const maxTele = Math.max(...results.map((r) => r.teleports));
  const moved = best > 60;
  const clean = maxTele === 0;
  if (!moved || !clean) fails++;
  console.log(`  关 ${String(lv.id).padStart(2)} ${String(lv.name).padEnd(6)}  最大位移 ${String(Math.round(best)).padStart(4)}px ` +
    `移动=${moved ? 'OK' : 'FAIL'}  瞬移=${clean ? 'OK' : 'FAIL(' + maxTele + ')'}` +
    `  [${results.map((r) => r.dir + ':' + Math.round(r.maxReach) + (r.stopped ? '死' : '')).join(' ')}]`);
}

console.log('\n== 逐关：翻转后能飞向对面泳道 ==');
for (const lv of ALL) {
  const L = P.compileLevel(lv);
  const s = P.createSim(L);
  for (let i = 0; i < 3; i++) P.stepSim(s, {}, DT);
  const y0 = s.dyn.py;
  P.stepSim(s, { flip: true }, DT);
  let teleports = 0, prev = s.dyn.py;
  for (let i = 0; i < 90; i++) {
    P.stepSim(s, {}, DT);
    if (Math.abs(s.dyn.py - prev) > 60) teleports++;
    prev = s.dyn.py;
  }
  const moved = Math.abs(s.dyn.py - y0) > 80;
  const grounded = s.dyn.grounded;
  const clean = teleports === 0;
  if (!moved || !grounded || !clean) fails++;
  console.log(`  关 ${String(lv.id).padStart(2)} ${String(lv.name).padEnd(6)}  重力=^ 位移${Math.round(Math.abs(s.dyn.py - y0))}px ` +
    `贴地=${grounded ? 'OK' : 'FAIL'} 瞬移=${clean ? 'OK' : 'FAIL'}(${teleports}) y=${Math.round(s.dyn.py)}`);
  if (verbose) console.log(`      spawn=(${L.spawn.col},${L.spawn.row}) 出口=(${L.exit.col},${L.exit.row}) 星=${L.stars.length}`);
}

console.log('\n卡角/瞬移回归: ' + (fails === 0 ? '全部通过' : fails + ' 项失败'));
process.exit(fails ? 1 : 0);
