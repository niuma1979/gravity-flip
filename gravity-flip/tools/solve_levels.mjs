'use strict';
/* =========================================================================
 * 关卡可解性验证器（Lead 使用；不参与游戏运行时）
 *
 * 权威来源：与游戏运行时完全相同的 js/physics.js。
 *
 * 算法：宏动作最佳优先搜索（Best-First Search over macro actions）
 *   - 宏动作 = 「方向输入保持 N 帧 + 是否跳跃 + 是否翻转」，覆盖了
 *     走路 / 跳跃 / 墙跳 / 翻转飞行 / 原地等待 等全部真实操作。
 *   - 启发式 = 到最近未收集目标（星或出口）的欧氏距离 / 水平速度，
 *     它低估真实到达时间，因此搜索偏向朝目标推进，而不会漏掉长距离飞行。
 *   - 找到解后做删步压缩，得到较漂亮的参考解（翻转次数/用时）。
 *
 * 用法: node tools/solve_levels.mjs [起始关] [结束关] [--nodes N]
 * ========================================================================= */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const PHYSICS = require(path.join(root, 'js', 'physics.js'));
const { LEVELS_1_6 } = require(path.join(root, 'js', 'levels.js'));
let LEVELS_7_12 = [];
try { LEVELS_7_12 = require(path.join(root, 'js', 'levels7-12.js')).LEVELS_7_12 || []; } catch (e) { /* 队友还没交 */ }
const ALL = LEVELS_1_6.concat(LEVELS_7_12).sort((a, b) => a.id - b.id);

const { PHYS, compileLevel, createSim, stepSim } = PHYSICS;
const DT = PHYS.DT;

/* ------------------------------ 宏动作库 ------------------------------ */

const HULLS = [6, 10, 16, 26, 40];     // 保持方向输入的帧数
const NO_FLIP = process.argv.includes('--no-flip');   // 0 翻转基线探针
const ALL_MACROS = [];
for (const dir of [-1, 0, 1]) {
  for (const jump of [false, true]) {
    // 不翻转
    for (const n of HULLS) ALL_MACROS.push({ dir, jump, flip: false, n });
    // 起手翻转
    ALL_MACROS.push({ dir, jump, flip: true, n: 6 });
    ALL_MACROS.push({ dir, jump, flip: true, n: 14 });
    ALL_MACROS.push({ dir, jump, flip: true, n: 30 });
  }
}
// 纯等待（应对移动锯）
ALL_MACROS.push({ dir: 0, jump: false, flip: false, n: 20, idle: true });
// --no-flip：只保留不含 flip 的宏，用来回答「禁止翻转还能不能通关」
const MACROS = NO_FLIP ? ALL_MACROS.filter((m) => !m.flip) : ALL_MACROS;

const MAX_FLIGHT = 40;                 // 单个宏动作最多模拟帧数（含翻转后飞行）

function cloneState(s) {
  const c = createSim(s.L);
  const d = s.dyn;
  c.dyn.px = d.px; c.dyn.py = d.py; c.dyn.vx = d.vx; c.dyn.vy = d.vy;
  c.dyn.gravity = d.gravity; c.dyn.grounded = d.grounded; c.dyn.onWall = d.onWall;
  c.dyn.flipCount = d.flipCount; c.dyn.deaths = d.deaths;
  c.dyn.dead = d.dead; c.dyn.finished = d.finished; c.dyn.won = d.won;
  c.dyn.failed = d.failed; c.dyn.invuln = d.invuln; c.dyn.starsTaken = d.starsTaken;
  c.stars = s.stars.map((x) => ({ x: x.x, y: x.y, taken: x.taken }));
  c.time = s.time; c.started = s.started; c.sawT = s.sawT; c.respawnIn = s.respawnIn;
  c.prevJump = s.prevJump; c.prevFlip = s.prevFlip;
  c.anim = { x: s.anim.x, y: s.anim.y };
  return c;
}

/** 执行一个宏动作：前 n 帧按下输入，其后维持方向输入但松开跳/翻，直到落地或超时 */
function applyMacro(state, m) {
  const s = cloneState(state);
  let released = false;
  for (let i = 0; i < MAX_FLIGHT; i++) {
    const held = i < m.n;
    const keys = {
      left: m.dir < 0,
      right: m.dir > 0,
      jump: held && m.jump,
      flip: held && m.flip
    };
    if (m.idle && i >= m.n) break;
    stepSim(s, keys, DT);
    if (s.dyn.won || s.dyn.failed || s.dyn.dead) return s;
    if (i >= m.n) {
      released = true;
      // 松开跳/翻后继续飞，直到重新落地
      if (s.dyn.grounded && i > m.n + 2) break;
    }
    if (released && i > m.n + 30) break;
  }
  return s;
}

/* --------------------------- 目标与启发式 ---------------------------- */

function goalsOf(s) {
  const out = [];
  for (const st of s.stars) if (!st.taken) out.push({ x: st.x, y: st.y, kind: 'star' });
  if (!out.length) out.push({ x: s.L.exit.x, y: s.L.exit.y, kind: 'exit' });
  return out;
}
function nearest(s) {
  const d = s.dyn;
  let best = null, bd = Infinity;
  for (const g of goalsOf(s)) {
    const dd = Math.hypot(g.x - d.px, g.y - d.py);
    if (dd < bd) { bd = dd; best = g; }
  }
  return { goal: best, dist: bd };
}
function heuristic(s) {
  if (s.dyn.won) return 0;
  return nearest(s).dist / PHYS.MOVE_SPEED;
}

/* ------------------------------- 二叉堆 ------------------------------- */

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(n) { const a = this.a; a.push(n); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; const t = a[p]; a[p] = a[i]; a[i] = t; i = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  }
}

const POS_BIN = 12, VEL_BIN = 240;
function keyOf(s) {
  const d = s.dyn;
  let mask = 0;
  for (let i = 0; i < s.stars.length; i++) if (s.stars[i].taken) mask |= (1 << i);
  return (
    Math.round(d.px / POS_BIN) + '|' + Math.round(d.py / POS_BIN) + '|' +
    Math.round(d.vx / VEL_BIN) + '|' + Math.round(d.vy / VEL_BIN) + '|' +
    d.gravity + '|' + (d.grounded ? 1 : 0) + '|' + mask
  );
}

/* -------------------------------- 搜索 -------------------------------- */

function search(level, opts) {
  opts = opts || {};
  const maxNodes = opts.maxNodes || 150000;
  const maxTime = opts.maxTime || 90;         // 游戏内秒数上限
  const weight = opts.weight || 1.0;
  const L = compileLevel(level);
  const start = createSim(L);
  const open = new Heap();
  const seen = new Set();
  const root = { s: start, g: 0, parent: null, macro: null };
  seen.add(keyOf(start));
  open.push({ f: heuristic(start) * weight, node: root });
  let expanded = 0;

  while (open.size && expanded < maxNodes) {
    const cur = open.pop();
    expanded++;
    const node = cur.node, s = node.s;
    if (s.dyn.won) return { ok: true, state: s, node, expanded, seen: seen.size };

    for (const m of MACROS) {
      const ns = applyMacro(s, m);
      if (ns.dyn.failed) continue;
      if (ns.time > maxTime) continue;
      const k = keyOf(ns);
      if (seen.has(k)) continue;
      seen.add(k);
      const child = { s: ns, g: node.g + 1, parent: node, macro: m };
      if (ns.dyn.won) return { ok: true, state: ns, node: child, expanded, seen: seen.size };
      if (ns.dyn.dead) continue;   // 死亡后回到出生点：这条路直接丢弃（简化处理）
      open.push({ f: child.g + heuristic(ns) * weight, node: child });
    }
  }
  return { ok: false, expanded, seen: seen.size, reason: 'budget' };
}

/* --------------------- 参考解压缩：删掉多余的宏动作 --------------------- */

function replayPlan(L, macros) {
  const s = createSim(L);
  for (const m of macros) {
    const s2 = applyMacro(s, m);
    // 就地替换（applyMacro 返回克隆，需要拷回）
    Object.assign(s.dyn, s2.dyn);
    s.stars = s2.stars; s.time = s2.time; s.sawT = s2.sawT; s.started = s2.started;
    s.respawnIn = s2.respawnIn; s.prevJump = s2.prevJump; s.prevFlip = s2.prevFlip;
    if (s.dyn.won || s.dyn.failed) break;
  }
  return s;
}

function shrink(L, macros) {
  let cur = macros.slice();
  for (let pass = 0; pass < 40; pass++) {
    let improved = false;
    for (let i = 0; i < cur.length; i++) {
      const trial = cur.slice(0, i).concat(cur.slice(i + 1));
      const s = replayPlan(L, trial);
      if (s.dyn.won) { cur = trial; improved = true; break; }
    }
    if (!improved) break;
  }
  return cur;
}

/* -------------------------------- main -------------------------------- */

function parseArgs() {
  const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const from = nums[0] || 1;
  const to = nums[1] || 99;
  const ni = process.argv.indexOf('--nodes');
  const maxNodes = ni >= 0 ? Number(process.argv[ni + 1]) : 150000;
  const verbose = process.argv.includes('--verbose');
  const path = process.argv.includes('--path');
  return { from, to, maxNodes, verbose, path };
}

const args = parseArgs();
const only = ALL.filter((l) => l.id >= args.from && l.id <= args.to);
if (!only.length) { console.log('没有找到要验证的关卡'); process.exit(2); }

/* ---- 0 翻转基线探针：回答「禁止翻转还能不能通」 ---- */
const noFlipProbe = {};
if (NO_FLIP) {
  console.log('== --no-flip 模式：只允许不翻转的宏动作 ==');
  for (const lv of only) {
    const r = search(lv, { maxNodes: args.maxNodes, maxTime: 120, weight: 1.25 });
    noFlipProbe[lv.id] = { ok: !!r.ok, flips: r.ok ? r.state.dyn.flipCount : null, time: r.ok ? +r.state.time.toFixed(2) : null };
    console.log(`  关 ${String(lv.id).padStart(2)} ${String(lv.name).padEnd(6)} 禁止翻转 -> ` +
      (r.ok ? `仍可通关（${r.state.time.toFixed(2)}s，0 次翻转）` : '未搜到解（不等于证明无解）'));
  }
  const outP = path.join(root, 'reports', 'noflip_report.json');
  fs.mkdirSync(path.dirname(outP), { recursive: true });
  fs.writeFileSync(outP, JSON.stringify({ generatedAt: new Date().toISOString(), noFlipProbe }, null, 2));
  console.log('\n报告: ' + outP);
  process.exit(0);
}

// 读取上次 --no-flip 的结果作为闸门输入（没有就退化为「只查 par 紧贴度」）
let noFlipBaseline = {};
try {
  const p = path.join(root, 'reports', 'noflip_report.json');
  if (fs.existsSync(p)) noFlipBaseline = JSON.parse(fs.readFileSync(p, 'utf8')).noFlipProbe || {};
} catch (e) { /* 忽略 */ }
args.noFlipProbe = noFlipBaseline;

let gateFailLevels = 0;

let failures = 0;
const report = [];
for (const lv of only) {
  const t0 = Date.now();
  const par = lv.par || { flips: 99, time: 999 };
  // 多轮不同权重的搜索取最优：加权启发式会牺牲最优性换取速度，
  // 换权重相当于换一种取舍，取最小值能得到更紧的「参考解」。
  let res = { ok: false, expanded: 0 };
  let macros = [];
  const weights = [1.25, 1.05, 1.6];
  for (const w of weights) {
    if (res.ok && res.state.dyn.flipCount <= 3) break;
    let r;
    try { r = search(lv, { maxNodes: args.maxNodes, maxTime: Math.max(60, par.time * 2), weight: w }); }
    catch (e) { r = { ok: false, error: e.message, expanded: 0 }; }
    res.expanded = (res.expanded || 0) + (r.expanded || 0);
    if (!r.ok) { if (!res.ok) res = { ok: false, reason: r.reason || r.error, expanded: res.expanded }; continue; }
    if (!res.ok || r.state.dyn.flipCount < res.state.dyn.flipCount ||
        (r.state.dyn.flipCount === res.state.dyn.flipCount && r.state.time < res.state.time)) {
      res = r;
    }
  }
  const ms = Date.now() - t0;

  if (!res.ok) {
    failures++;
    console.log(`关 ${String(lv.id).padStart(2)} ${String(lv.name).padEnd(6)} FAIL  ${res.reason || res.error}  展开${res.expanded || 0}  ${ms}ms`);
    report.push({ id: lv.id, ok: false, reason: res.reason || res.error });
    continue;
  }

  // 取出宏动作序列并压缩
  const macrosFound = [];
  for (let n = res.node; n && n.parent; n = n.parent) macrosFound.unshift(n.macro);
  macros = macrosFound;
  let L, finalState = res.state, finalMacros = macros;
  try {
    L = compileLevel(lv);
    const tight = shrink(L, macros);
    const s = replayPlan(L, tight);
    if (s.dyn.won) { finalMacros = tight; finalState = s; }
  } catch (e) { /* 压缩失败则用原始解 */ }

  const d = finalState.dyn;
  const timeOk = finalState.time <= par.time;
  const flipOk = d.flipCount <= par.flips;

  // 难度/诚实性闸门（经独立验证者证伪后修正）：
  //
  // 之前我把「最少翻转 >= 1」当成「翻转是通关必需」的证据，但搜索找到的解
  // 的翻转数并不等于最小翻转数 —— 验证者用「删掉所有 flip 宏」的探针证明
  // 第 8 关可以 0 翻转通关。所以这里改成两个诚实分开判据：
  //   A) noFlipSolvable：禁止翻转时仍能通关的关卡 —— 翻转在这些关是「优化手段」
  //      而不是硬性要求（早期 2 泳道走廊 + 天花板缺口的结构必然如此）。
  //      这类关卡只要求 par 贴住实测最优（保证三星仍是效率挑战）。
  //   B) 禁止翻转确实找不到解（noFlipSolvable=false）的关卡 —— 才要求
  //      flipCount >= 1。
  // 注意 noFlipSolvable=false 只代表「没搜到」，不代表「已证明无解」，报告里如实标注。
  const noFlip = args.noFlipProbe ? args.noFlipProbe[lv.id] : null;
  const flipsRequired = !(noFlip && noFlip.ok);
  const flipEarned = flipsRequired ? d.flipCount >= 1 : true;
  // par 必须贴住搜索到的最优解（允许 1 次冗余），否则「三星」就是白送
  const parTight = par.flips <= d.flipCount + 1;
  let gateFails = 0;
  if (!flipEarned) gateFails++;
  if (!parTight) gateFails++;
  if (gateFails) gateFailLevels++;
  if (!flipEarned) failures++;
  const tag = (noFlip && noFlip.ok) ? '翻转可选' : '翻转必需';
  console.log(
    `关 ${String(lv.id).padStart(2)} ${String(lv.name).padEnd(6)} ${gateFails ? 'WEAK' : 'PASS'}  flips=${d.flipCount}(par ${par.flips}) time=${finalState.time.toFixed(2)}s(par ${par.time}) 死亡${d.deaths} 宏步${finalMacros.length} 展开${res.expanded} ${ms}ms [${tag} ${timeOk ? 'time-ok' : 'TIME-SLOW'} ${flipOk ? 'flips-ok' : 'FLIPS-HIGH'}${flipEarned ? '' : ' FLIP-NOT-REQUIRED'}${parTight ? '' : ' PAR-LOOSE'}]`
  );
  if (args.verbose) {
    console.log('   宏动作: ' + finalMacros.map((m) => `${m.flip ? 'F' : ''}${m.jump ? 'J' : ''}${m.dir < 0 ? 'L' : m.dir > 0 ? 'R' : '·'}${m.n}`).join(' '));
  }
  if (args.path) {
    const L2 = compileLevel(lv);
    let s = createSim(L2);
    console.log('   path: 起点 (' + Math.round(s.dyn.px) + ',' + Math.round(s.dyn.py) + ')');
    for (const m of finalMacros) {
      const s2 = applyMacro(s, m);
      Object.assign(s.dyn, s2.dyn);
      s.stars = s2.stars; s.time = s2.time; s.sawT = s2.sawT; s.started = s2.started;
      s.respawnIn = s2.respawnIn; s.prevJump = s2.prevJump; s.prevFlip = s2.prevFlip;
      const tag = `${m.flip ? 'F' : '·'}${m.jump ? 'J' : '·'}${m.dir < 0 ? 'L' : m.dir > 0 ? 'R' : '·'}${String(m.n).padStart(2)}`;
      console.log(`     ${tag} -> (${String(Math.round(s.dyn.px)).padStart(4)},${String(Math.round(s.dyn.py)).padStart(3)}) g=${s.dyn.gravity > 0 ? 'v' : '^'} vy=${String(Math.round(s.dyn.vy)).padStart(5)} 星=${s.dyn.starsTaken} t=${s.time.toFixed(2)}`);
    }
  }
  report.push({ id: lv.id, ok: true, flips: d.flipCount, time: +finalState.time.toFixed(2), deaths: d.deaths, parFlips: par.flips, parTime: par.time, timeOk, flipOk, flipEarned, flipRequired: flipsRequired, noFlipSolvable: !!(noFlip && noFlip.ok), parTight, macroSteps: finalMacros.length });
}

console.log('\n--- 结构自检 ---');
for (const lv of only) {
  let L;
  try { L = compileLevel(lv); } catch (e) { console.log(`关 ${lv.id} 编译失败: ${e.message}`); failures++; continue; }
  const problems = [];
  if (L.map.length !== 18) problems.push('行数 ' + L.map.length);
  L.map.forEach((row, i) => { if (row.length !== 32) problems.push('第' + i + '行宽 ' + row.length); });
  if (L.stars.length !== 3) problems.push('星数 ' + L.stars.length);
  if (problems.length) { console.log(`关 ${lv.id} 结构问题: ${problems.join('; ')}`); failures++; }
}
if (!failures) console.log('全部关卡结构 OK');

const outPath = path.join(root, 'reports', 'solve_report.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  levels: only.length,
  unsolvableOrFlipGateFailed: failures,
  weakParLevels: gateFailLevels,
  report
}, null, 2));
console.log('\n报告: ' + outPath);
console.log('不可通/翻转必需性失败的关卡数: ' + failures + ' / ' + only.length);
if (gateFailLevels) console.log('par 偏松或翻转冗余的关卡数: ' + gateFailLevels + ' / ' + only.length);
process.exit(failures ? 1 : 0);
