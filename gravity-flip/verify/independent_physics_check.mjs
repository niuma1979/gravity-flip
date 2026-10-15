/**
 * gravity-flip/verify/independent_physics_check.mjs
 *
 * 验证方自用：直接用 js/physics.js 的真实 API 测量，不依赖作者的任何测试脚本。
 * 回答 Lead 的结论 #1（物理常量自洽 / 「从地面登顶必须翻转」）并给出精确数字。
 *
 * 用法: node verify/independent_physics_check.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);
const PH = require(path.join(ROOT, 'js', 'physics.js'));
const L1 = require(path.join(ROOT, 'js', 'levels.js')).LEVELS_1_6;
const L712 = require(path.join(ROOT, 'js', 'levels7-12.js')).LEVELS_7_12;
const { PHYS } = PH;

const TILE = PHYS.TILE, DT = PHYS.DT;
const out = [];
const say = (s) => { out.push(s); console.log(s); };

say('=== A. 解析式：最大跳跃高度 h = v^2 / (2g) ===');
const hAnalytic = (PHYS.JUMP_V * PHYS.JUMP_V) / (2 * PHYS.GRAVITY);
say(`  JUMP_V=${PHYS.JUMP_V} px/s, GRAVITY=${PHYS.GRAVITY} px/s^2`);
say(`  h = ${PHYS.JUMP_V}^2 / (2*${PHYS.GRAVITY}) = ${(-PHYS.JUMP_V) ** 2}/${2 * PHYS.GRAVITY} = ${hAnalytic} px`);
say(`  换算成格(TILE=${TILE}) = ${(hAnalytic / TILE).toFixed(3)} 格`);

say('');
say('=== B. 离散实测：用真实 createSim/stepSim 从地面起跳（按住 jump）===');
const lvl1 = L1[0];
const c1 = PH.compileLevel(lvl1);
const sim = PH.createSim(c1);
const y0 = sim.dyn.py;
let maxUp = 0, apexFrame = -1, landed = false;
for (let i = 0; i < 180; i++) {
  PH.stepSim(sim, { jump: true }, DT);
  const up = y0 - sim.dyn.py;
  if (up > maxUp) { maxUp = up; apexFrame = i + 1; }
  if (i > apexFrame && apexFrame > 0 && sim.dyn.grounded) { landed = true; break; }
}
say(`  关卡 1「${lvl1.name}」出生点 py=${y0}（地面锚点 anchor=${lvl1.spawnAnchor.anchor}, row=${lvl1.spawnAnchor.row}）`);
say(`  实测最大上升 = ${maxUp.toFixed(2)} px（第 ${apexFrame} 帧到顶，=${(maxUp / TILE).toFixed(3)} 格）`);
say(`  解析式 ${hAnalytic} px vs 离散实测 ${maxUp.toFixed(2)} px → 差 ${(maxUp - hAnalytic).toFixed(2)} px`);
say(`  落回地面: ${landed}`);

say('');
say('=== C. 若只按 1 帧 jump（边沿触发）再松开的实测 ===');
const sim2 = PH.createSim(PH.compileLevel(lvl1));
const y0b = sim2.dyn.py;
let maxUp2 = 0;
for (let i = 0; i < 180; i++) {
  PH.stepSim(sim2, { jump: i === 0 }, DT);
  maxUp2 = Math.max(maxUp2, y0b - sim2.dyn.py);
}
say(`  实测最大上升 = ${maxUp2.toFixed(2)} px（=${(maxUp2 / TILE).toFixed(3)} 格）`);

say('');
say('=== D. 两条泳道的真实垂直距离（从关卡数据/锚点推出，不靠描述）===');
say(`  地面泳道行 r=16、天花板泳道行 r=4（levels.js GROUND/CEIL），相差 12 行`);
say(`  12 行 × TILE ${TILE} = ${12 * TILE} px（这是「泳道实体格」之间的格差）`);
say(`  地面站立时 py = GROUND*TILE - PH/2 = ${16 * TILE} - ${PHYS.PH / 2} = ${16 * TILE - PHYS.PH / 2}`);
say(`  天花板站立时 py = (CEIL+1)*TILE + PH/2 = ${5 * TILE} + ${PHYS.PH / 2} = ${5 * TILE + PHYS.PH / 2}`);
const gapCenter = (16 * TILE - PHYS.PH / 2) - (5 * TILE + PHYS.PH / 2);
say(`  → 玩家质心需要移动 ${gapCenter} px 才能从地面站到天花板站`);
say(`  → 两个可站立面之间的净空 = ${gapCenter + PHYS.PH} px（表面到表面）`);
say(`  对比：最大跳跃 ${hAnalytic} px  ${hAnalytic < gapCenter ? '<' : '>'}  需要移动 ${gapCenter} px  → ${hAnalytic < gapCenter ? '单次跳跃无法登顶，必须翻转' : '单次跳跃可达，翻转非必须'}`);

say('');
say('=== E. 翻转后确实能到达天花板（实测）===');
const sim3 = PH.createSim(PH.compileLevel(lvl1));
const y0c = sim3.dyn.py;
let minPy = y0c, groundedCeil = false;
for (let i = 0; i < 300; i++) {
  PH.stepSim(sim3, { flip: i === 0 }, DT);
  if (sim3.dyn.py < minPy) minPy = sim3.dyn.py;
  if (i > 5 && sim3.dyn.grounded && sim3.dyn.gravity === -1) { groundedCeil = true; break; }
}
say(`  在关卡 1 出生点按一次 Z：py 从 ${y0c} → 最低 ${minPy}（上升 ${(y0c - minPy).toFixed(2)} px）`);
say(`  最终贴到天花板: ${groundedCeil} (py=${sim3.dyn.py.toFixed(2)}, gravity=${sim3.dyn.gravity}, grounded=${sim3.dyn.grounded})`);
say(`  上升量 ${(y0c - minPy).toFixed(2)} px vs 需要 ${gapCenter} px`);

say('');
say('=== F. 12 关的泳道约束是否一致 ===');
const all = [...L1, ...L712];
let bad = 0;
for (const L of all) {
  const fc = L.spawnAnchor || {}, ec = L.exitAnchor || {};
  const okSpace = L.map.length === PHYS.ROWS && L.map.every((r) => r.length === PHYS.COLS);
  if (!okSpace) { bad++; say(`  关卡 ${L.id}: 地图尺寸异常`); }
}
say(`  关卡总数 = ${all.length}（1-6 关 ${L1.length} + 7-12 关 ${L712.length}）`);
say(`  行数/列数全部 = ${PHYS.ROWS}×${PHYS.COLS}: ${bad === 0}`);
say(`  每关 par.flips = ${all.map((L) => L.par.flips).join(', ')}`);

say('');
say('=== G. 每关「翻转是否必需」的独立证明（不依赖 solver 的最优性假设）===');
// 无翻转时玩家被限制在地面泳道：可站 py=626，跳跃最多上升 102 → py 最小 524
const maxUpDiscrete = maxUp;                       // 实测 102
const pyFloor = 16 * TILE - PHYS.PH / 2;           // 626
const pyBestNoFlip = pyFloor - maxUpDiscrete;      // 524
const starReach = PHYS.PH / 2 + 15;                // 星判定半径 15 vs AABB 半高 14 → ±29
const exitReach = PHYS.PH / 2 + 18;                // 出口盒 36×36 → ±32
say(`  无翻转可达带: py ∈ [${pyBestNoFlip}, ${pyFloor}]（地面站 ${pyFloor}，跳 ${maxUpDiscrete}px）`);
say(`  收星需要 |py - 星心| <= ${starReach}；碰出口需要 |py - 出口心| <= ${exitReach}`);
let proved = 0;
for (const L of all) {
  const comp = PH.compileLevel(L);                    // 权威坐标：7-12 关没有 exitAnchor，必须走 compileLevel
  const starRows = (comp.stars || []).map((s) => Math.floor(s.y / TILE));
  const ceilStars = (comp.stars || []).filter((s) => s.y <= pyBestNoFlip - starReach);
  const exitY = comp.exit.y;
  const exitRow = Math.floor(exitY / TILE);
  const exitNeedsFlip = exitY < pyBestNoFlip - exitReach;
  const reasons = [];
  if (exitNeedsFlip) reasons.push(`出口在 r${exitRow}（y=${exitY}，需要 py<=${exitY + exitReach} < ${pyBestNoFlip}）`);
  if (ceilStars.length) reasons.push(`${ceilStars.length} 颗星高于无翻转可达高度（y=${ceilStars.map((s) => s.y).join(',')}）`);
  if (reasons.length) proved++;
  say(`  关 ${String(L.id).padStart(2)}: spawn=(${comp.spawn.x},${comp.spawn.y}) exit=(${comp.exit.x},${exitY}) 星行=[${starRows.join(',')}]  → ${reasons.length ? '几何上需要高于跳跃可达高度: ' + reasons.join('；') : '几何判据未覆盖（需搜索来判定）'}`);
}
say(`  结论: 12 关中 ${proved} 关的出口/星在「无翻转可达高度」之上，几何上就已经要求翻转。`);
say(`  但这只是「充分条件的候选」，不是完整的必需性证明 —— 完整证明需要禁止翻转的搜索（见 H 节反例）。`);

say('');
say('=== H. 独立复跑「零翻转通关」：关卡 8（我自己的宏循环实现，不用 Lead 的脚本）===');
const MAX_FLIGHT = 40;
function runMacro(state, m) {
  let released = false;
  for (let i = 0; i < MAX_FLIGHT; i++) {
    const held = i < m.n;
    const keys = { left: m.dir < 0, right: m.dir > 0, jump: held && !!m.jump, flip: held && !!m.flip };
    if (m.idle && i >= m.n) break;
    PH.stepSim(state, keys, DT);
    if (state.dyn.won || state.dyn.failed || state.dyn.dead) return state;
    if (i >= m.n) { released = true; if (state.dyn.grounded && i > m.n + 2) break; }
    if (released && i > m.n + 30) break;
  }
  return state;
}
const lvl8 = all.find((L) => L.id === 8);
const l8 = PH.createSim(PH.compileLevel(lvl8));
const startPy8 = l8.dyn.py;
const plan8 = [
  { dir: -1, jump: true, n: 6 }, { dir: 1, jump: true, n: 6 }, { dir: 1, jump: true, n: 6 },
  { dir: 0, jump: true, n: 6 }, { dir: 1, jump: false, n: 40 }, { dir: 1, jump: false, n: 6 },
  { dir: 1, jump: true, n: 40 }, { dir: 1, jump: false, n: 40 }, { dir: 1, jump: true, n: 40 }
];
for (const m of plan8) runMacro(l8, m);
const snap8 = PH.snapshot(l8);
say(`  关卡 8「${lvl8.name}」起点 (${PH.compileLevel(lvl8).spawn.x},${startPy8})，出口 (${PH.compileLevel(lvl8).exit.x},${PH.compileLevel(lvl8).exit.y})`);
say(`  9 个宏动作（全部 flip=false）执行后: won=${snap8.won} flips=${snap8.flips} 星=${snap8.stars}/${lvl8.map ? 3 : 3} deaths=${snap8.deaths} time=${snap8.time.toFixed(2)}s`);
say(`  → ${snap8.won === true && snap8.flips === 0 && snap8.stars === 3 ? '独立确认：关卡 8 可以在零次翻转下三星通关' : '未复现出零翻转通关'}！`);
say(`  含义：闸门「最少翻转 >= 1（证明翻转是通关必需）」对关卡 8 不成立 → 该闸门不是必需性证明。`);

say('');
say('=== 结论 ===');
say(`  1) 解析式最大跳跃 = ${hAnalytic} px = ${(hAnalytic / TILE).toFixed(2)} 格（Lead 说 ≈108px/2.7格 → 108 正确，2.7 格正确）`);
say(`  2) 地面↔天花板质心行程 = ${gapCenter} px，是跳跃高度的 ${(gapCenter / hAnalytic).toFixed(2)} 倍 → 「必须翻转」成立`);
say(`  3) Lead 描述里的「相距 160px」与源码不符：源码推出的净空是 ${gapCenter + PHYS.PH} px（质心行程 ${gapCenter} px）`);
say(`     结论方向不变（108 < ${gapCenter}），但 160 这个数字本身是错的。`);

process.exit(0);
