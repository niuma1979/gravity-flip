'use strict';
/* =========================================================================
 * GRAVITY FLIP — 第 1–6 关（Lead 负责）
 *
 * 设计基线（三件事保证「翻转」是通关必需，而不是可选技巧）：
 *  1) 地面 r16 / 天花板 r4 相距 160px，跳跃只有 108px
 *     —— 从地面登顶必须「跳到最高点再按 Z 翻转」。
 *  2) 天花板被切成 2 段，中间留大缺口：想一路贴天花板平推是不可能的，
 *     必须掉回地面再翻上去。这是第 1 版被搜索器破解后的针对性修复。
 *  3) 场景里放 2 格高的柱子：净高 72px < 108px 跳不上去；柱顶到天花板
 *     只有 2 格，翻转又会撞柱子 —— 只能靠一次精准的翻转时机通过。
 *
 * 坐标约定（已按玩家 AABB 24x28 校验）：
 *   地面泳道：站在实心行 r16(y=660) 上，身体中心在 r16 格心即可
 *   天花板泳道：吊在实心行 r4(y=180) 下，身体中心在 r5 格心 (y=220)
 *   所以「天花板上的星/出口」行号必须是 CEIL+1，「地面上的星」是 GROUND-1。
 *
 * 瓦片：'.' 空  '#' 实心  'P' 出生  'E' 出口  '*' 星
 *       '^' 地面尖刺  'v' 天花板尖刺
 * ========================================================================= */

const COLS = 32, ROWS = 18;
const GROUND = 16, CEIL = 4;

function blankGrid() {
  const g = [];
  for (let r = 0; r < ROWS; r++) g.push(new Array(COLS).fill('.'));
  return g;
}
function fill(g, c0, c1, r0, r1, ch) {
  // 所有矩形必须完整落在世界内：越界一律当成作者写错了，直接报错而不是静默裁掉。
  // 否则 join('') 会让行宽悄悄变短，最终生成一张自相矛盾的地图。
  if (c0 < 0 || c1 > COLS - 1 || r0 < 0 || r1 > ROWS - 1 || c1 < c0 || r1 < r0) {
    throw new Error(`fill 矩形非法: c${c0}..${c1} r${r0}..${r1}`);
  }
  if (ch === undefined || ch === null) ch = '#';   // 结构类矩形省略 ch 时默认实心
  if (String(ch).length !== 1) throw new Error(`fill 字符非法: ${JSON.stringify(ch)}`);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r][c] = ch;
}
function frameAll(g) {
  fill(g, 0, COLS - 1, 0, 2, '#');
  fill(g, 0, COLS - 1, 17, 17, '#');
  fill(g, 0, 0, 0, ROWS - 1, '#');
  fill(g, COLS - 1, COLS - 1, 0, ROWS - 1, '#');
}

/** 编译前先把「对象会不会互相叠」查出来，避免生成一张自相矛盾的地图 */
function build(spec) {
  const g = blankGrid();
  frameAll(g);
  for (const s of (spec.struct || [])) fill(g, s.c0, s.c1, s.r0, s.r1, s.ch || '#');
  for (const s of (spec.spikes || [])) fill(g, s.c0, s.c1, s.r0, s.r1, s.ch);
  for (const p of (spec.stars || [])) {
    const r = p[1], c = p[0];
    if (g[r][c] !== '.') throw new Error(`level ${spec.id}: 星 (${c},${r}) 落在 '${g[r][c]}' 上，必须放在空格`);
    g[r][c] = '*';
  }
  // 出生点/出口允许放在「泳道实体格里」（那正是地板/天花板本体），但必须与星、刺错开
  const at = (p) => g[p[1]][p[0]];
  if (at(spec.spawn) === '*') throw new Error(`level ${spec.id}: 出生点压到星`);
  if (at(spec.exit) === '*') throw new Error(`level ${spec.id}: 出口压到星`);
  if (at(spec.spawn) === '^' || at(spec.spawn) === 'v') throw new Error(`level ${spec.id}: 出生点落在尖刺上`);
  if (at(spec.exit) === '^' || at(spec.exit) === 'v') throw new Error(`level ${spec.id}: 出口落在尖刺上`);
  g[spec.spawn[1]][spec.spawn[0]] = 'P';
  g[spec.exit[1]][spec.exit[0]] = 'E';
  const map = g.map(function (row) { return row.join(''); });
  map.forEach(function (row, i) {
    if (row.length !== COLS) throw new Error('level ' + spec.id + ' row ' + i + ' width ' + row.length);
    if (/undefined|null/.test(row)) throw new Error('level ' + spec.id + ' row ' + i + ' 含 undefined/null 空洞');
  });

  // 泳道锚点归一化 + 支撑断言。
  // 注意：出生点/出口字符本身就是「泳道实体格」，physics 会把这两个格子设为实心
  // （见 solidCells），所以锚点不会被当成地板上的洞。这里只做断言，不改地图字符，
  // 否则 physics 就找不到 P/E 了。
  const bodyH = 28;
  const isSolid = (c, r) => map[r][c] === '#' || map[r][c] === 'P' || map[r][c] === 'E';

  function assertSupport(p, row, anchorName) {
    if (p[1] !== row) return;
    if (!isSolid(p[0], row)) {
      throw new Error(`level ${spec.id}: ${anchorName} (${p[0]},${row}) 所在泳道格不是实体，会直接掉下去`);
    }
  }
  assertSupport(spec.spawn, GROUND, '出生点');
  assertSupport(spec.exit, GROUND, '出口');
  assertSupport(spec.exit, CEIL, '出口');

  const snap = (p, isGround) => {
    const [c, r] = p;
    if (isGround && r === GROUND) {
      return { col: c, row: r, y: GROUND * 40 - bodyH / 2, anchor: 'floor' };
    }
    if (r === CEIL) {
      return { col: c, row: r, y: (CEIL + 1) * 40 + bodyH / 2, anchor: 'ceiling' };
    }
    return { col: c, row: r, y: r * 40 + 20, anchor: 'free' };
  };

  return {
    id: spec.id, name: spec.name, hint: spec.hint, map: map,
    saws: spec.saws || [], par: spec.par || { flips: 99, time: 999 },
    spawnAnchor: snap(spec.spawn, true),
    exitAnchor: snap(spec.exit, false),
    // 这些格子要当成实心（锚点自己所占的泳道格）
    solidCells: [
      [spec.spawn[0], spec.spawn[1]],
      [spec.exit[0], spec.exit[1]]
    ]
  };
}

const RAW = [
  /* ---------------------------------------------------------------- 1 --- */
  {
    id: 1, name: '觉醒', hint: '按 Z 翻转重力：飞向天花板后，再按一次飞回地面',
    struct: [
      { c0: 2, c1: 31, r0: GROUND, r1: GROUND },
      { c0: 12, c1: 31, r0: CEIL, r1: CEIL },         // 天花板从第 12 列开始
      { c0: 19, c1: 21, r0: 14, r1: 15 }              // 跳上去才拿得到的星台
    ],
    spikes: [], saws: [],
    stars: [[20, 13], [10, 11], [27, 5]],
    spawn: [2, 16], exit: [28, 4],
    par: { flips: 4, time: 10 }
  },

  /* ---------------------------------------------------------------- 2 --- */
  {
    id: 2, name: '尖刺地窖', hint: '地板中间全是刺：先翻上天花板，到缺口再落回地面',
    struct: [
      { c0: 1, c1: 31, r0: GROUND, r1: GROUND },
      { c0: 1, c1: 12, r0: CEIL, r1: CEIL },
      { c0: 20, c1: 31, r0: CEIL, r1: CEIL }
    ],
    spikes: [{ c0: 12, c1: 19, r0: GROUND, r1: GROUND, ch: '^' }],
    saws: [],
    stars: [[4, 15], [8, 5], [27, 5]],
    spawn: [2, 16], exit: [29, 4],
    par: { flips: 2, time: 10 }
  },

  /* ---------------------------------------------------------------- 3 --- */
  {
    id: 3, name: '上下走廊', hint: '天花板中间断开：上面走一半就得落回地面',
    struct: [
      { c0: 1, c1: 31, r0: GROUND, r1: GROUND },
      { c0: 1, c1: 11, r0: CEIL, r1: CEIL },
      { c0: 21, c1: 31, r0: CEIL, r1: CEIL },
      { c0: 15, c1: 15, r0: 13, r1: 15 }
    ],
    spikes: [{ c0: 14, c1: 20, r0: GROUND, r1: GROUND, ch: '^' }],
    saws: [],
    stars: [[4, 15], [8, 5], [26, 5]],
    spawn: [2, 16], exit: [29, 4],
    par: { flips: 2, time: 10 }
  },

  /* ---------------------------------------------------------------- 4 --- */
  {
    id: 4, name: '巡逻锯', hint: '锯子来回巡逻，等它让开路再走',
    struct: [
      { c0: 1, c1: 31, r0: GROUND, r1: GROUND },
      { c0: 1, c1: 12, r0: CEIL, r1: CEIL },
      { c0: 21, c1: 31, r0: CEIL, r1: CEIL }
    ],
    spikes: [],
    saws: [
      { x: 400, y: 660, r: 18, axis: 'x', a: 280, b: 700, speed: 170, phase: 0.0 },
      { x: 400, y: 180, r: 18, axis: 'x', a: 200, b: 460, speed: 160, phase: 0.4 },
      { x: 900, y: 660, r: 18, axis: 'x', a: 760, b: 1150, speed: 180, phase: 0.7 }
    ],
    stars: [[4, 15], [9, 5], [26, 5]],
    spawn: [2, 16], exit: [29, 4],
    par: { flips: 2, time: 10 }
  },

  /* ---------------------------------------------------------------- 5 --- */
  {
    id: 5, name: '锯齿走廊', hint: '天上有刺、地上有锯：先看清路线再决定什么时候翻',
    struct: [
      { c0: 1, c1: 31, r0: GROUND, r1: GROUND },
      { c0: 1, c1: 12, r0: CEIL, r1: CEIL },
      { c0: 20, c1: 31, r0: CEIL, r1: CEIL }
    ],
    spikes: [
      { c0: 8, c1: 19, r0: GROUND, r1: GROUND, ch: '^' },
      { c0: 24, c1: 27, r0: CEIL, r1: CEIL, ch: 'v' }
    ],
    saws: [
      { x: 600, y: 520, r: 18, axis: 'x', a: 260, b: 1000, speed: 180, phase: 0.15 },
      { x: 300, y: 660, r: 18, axis: 'x', a: 200, b: 560, speed: 190, phase: 0.6 }
    ],
    stars: [[4, 15], [9, 5], [28, 5]],
    spawn: [2, 16], exit: [29, 4],
    par: { flips: 2, time: 10 }
  },

  /* ---------------------------------------------------------------- 6 --- */
  {
    id: 6, name: '竖井', hint: '一层一层交替借力，最后从右侧天花板出去',
    struct: [
      { c0: 1, c1: 31, r0: GROUND, r1: GROUND },
      { c0: 1, c1: 11, r0: CEIL, r1: CEIL },
      { c0: 21, c1: 31, r0: CEIL, r1: CEIL },
      { c0: 14, c1: 15, r0: 12, r1: 15 }
    ],
    spikes: [{ c0: 12, c1: 20, r0: GROUND, r1: GROUND, ch: '^' }],
    saws: [
      { x: 700, y: 260, r: 18, axis: 'y', a: 200, b: 420, speed: 140, phase: 0.1 },
      { x: 420, y: 560, r: 18, axis: 'x', a: 200, b: 520, speed: 170, phase: 0.5 }
    ],
    stars: [[4, 15], [8, 5], [27, 5]],
    spawn: [2, 16], exit: [29, 4],
    par: { flips: 2, time: 10 }
  }
];

const LEVELS_1_6 = RAW.map(build);

if (typeof module !== 'undefined' && module.exports) module.exports = { LEVELS_1_6: LEVELS_1_6 };
// 浏览器里通过拼接执行时必须挂到 window，否则打包后 game.js 读到 0 关
if (typeof window !== 'undefined') window.GF_LEVELS_1_6 = LEVELS_1_6;
