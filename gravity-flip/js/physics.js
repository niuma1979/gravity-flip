'use strict';
/* =========================================================================
 * GRAVITY FLIP — 纯确定性物理与关卡仿真
 * 这个文件不接触 DOM，可同时被浏览器（构建脚本会把它内联进页面）和
 * node（require）使用。游戏渲染与关卡验证必须共用这里的同一套规则，
 * 避免「验证器通过但玩不了」。
 * ========================================================================= */

const PHYS = {
  TILE: 40,
  W: 1280,
  H: 720,
  COLS: 32,
  ROWS: 18,

  GRAVITY: 2400,        // px/s^2，沿重力方向
  MOVE_SPEED: 300,      // px/s，恒定，无惯性
  JUMP_V: -720,         // 相对重力方向的初速度
  WALLJUMP_VX: 240,     // 墙跳获得的反向水平速度
  MAX_FALL: 1500,
  PW: 24,               // 玩家 AABB 宽
  PH: 28,               // 玩家 AABB 高
  H_INSET: 2,           // 水平碰撞时上下内缩像素（避免把地板/天花板当成墙）

  DT: 1 / 60,
  EPS: 0.5,             // 落地判定的贴地容差
  HURT_INVULN: 1.1,     // 受伤无敌时间（秒）
  MAX_DEATHS: 3,        // 第 4 次死亡 = 本关失败
  DEATH_PAUSE: 0.45,    // 死亡后短暂冻结，然后回到出生点
  SAW_R: 18
};

const GLYPHS = {
  SPAWN: 'P',
  EXIT: 'E',
  STAR: '*',
  SPIKE_UP: '^', SPIKE_DOWN: 'v', SPIKE_LEFT: '<', SPIKE_RIGHT: '>'
};

const SPIKE_DIRS = {
  '^': { dx: 0, dy: -1 },
  'v': { dx: 0, dy: 1 },
  '<': { dx: 1, dy: 0 },
  '>': { dx: -1, dy: 0 }
};

/** 把 ASCII 地图编译成可碰撞/可渲染的结构。level 对象可重复编译。 */
function compileLevel(level) {
  const map = level.map || [];
  if (map.length !== PHYS.ROWS) throw new Error('关卡 ' + level.id + ' 行数应为 ' + PHYS.ROWS + '，实际 ' + map.length);
  for (let r = 0; r < map.length; r++) {
    if (map[r].length !== PHYS.COLS) {
      throw new Error('关卡 ' + level.id + ' 第 ' + r + ' 行宽度应为 ' + PHYS.COLS + '，实际 ' + map[r].length);
    }
  }

  const solid = new Uint8Array(PHYS.COLS * PHYS.ROWS);
  const spikes = [];
  const stars = [];
  let spawn = null;
  let exit = null;

  for (let r = 0; r < PHYS.ROWS; r++) {
    for (let c = 0; c < PHYS.COLS; c++) {
      const ch = map[r][c];
      const cx = c * PHYS.TILE + PHYS.TILE / 2;
      const cy = r * PHYS.TILE + PHYS.TILE / 2;
      if (ch === '#') {
        solid[r * PHYS.COLS + c] = 1;
      } else if (ch === GLYPHS.SPAWN) {
        spawn = { x: cx, y: cy, col: c, row: r };
      } else if (ch === GLYPHS.EXIT) {
        exit = { x: cx, y: cy, col: c, row: r };
      } else if (ch === GLYPHS.STAR) {
        stars.push({ x: cx, y: cy, col: c, row: r, taken: false });
      } else if (SPIKE_DIRS[ch]) {
        const d = SPIKE_DIRS[ch];
        spikes.push({ x: cx, y: cy, col: c, row: r, g: ch, dx: d.dx, dy: d.dy });
      } else if (ch !== '.') {
        throw new Error('关卡 ' + level.id + ' 未知字符 "' + ch + '" @ (' + c + ',' + r + ')');
      }
    }
  }
  if (!spawn) throw new Error('关卡 ' + level.id + ' 缺少出生点 P');
  if (!exit) throw new Error('关卡 ' + level.id + ' 缺少出口 E');

  // 出生点/出口占用的泳道格必须仍然是实心：它们是「站在地板上的位置」，
  // 不是地板上的洞。关卡编译器会把这类格子列在 solidCells 里。
  for (const cell of (level.solidCells || [])) {
    const c = cell[0], r = cell[1];
    if (c >= 0 && c < PHYS.COLS && r >= 0 && r < PHYS.ROWS) solid[r * PHYS.COLS + c] = 1;
  }

  // 泳道锚点归一化：如果关卡提供了 spawnAnchor/exitAnchor（由关卡编译器算出），
  // 就用它把出生点/出口贴到地板顶面或天花板底面，避免 AABB 一半嵌进实体里。
  if (level.spawnAnchor && typeof level.spawnAnchor.y === 'number') {
    spawn.x = level.spawnAnchor.col * PHYS.TILE + PHYS.TILE / 2;
    spawn.y = level.spawnAnchor.y;
  }
  if (level.exitAnchor && typeof level.exitAnchor.y === 'number') {
    exit.x = level.exitAnchor.col * PHYS.TILE + PHYS.TILE / 2;
    exit.y = level.exitAnchor.y;
  }

  const saws = (level.saws || []).map(function (s, i) {
    return {      i: i, x: s.x, y: s.y, r: s.r || PHYS.SAW_R,
      axis: s.axis === 'y' ? 'y' : 'x',
      a: s.a, b: s.b, speed: s.speed, phase: s.phase || 0
    };
  });

  return {
    id: level.id,
    name: level.name || ('LEVEL ' + level.id),
    hint: level.hint || '',
    par: level.par || { flips: 99, time: 999 },
    map: map.slice(),
    solid: solid, spikes: spikes, saws: saws, stars: stars,
    spawn: spawn, exit: exit
  };
}

function makeSolidLookup(compiled) {
  const s = compiled.solid;
  return function (c, r) {
    if (c < 0 || c >= PHYS.COLS || r < 0 || r >= PHYS.ROWS) return true; // 世界外视为实心
    return s[r * PHYS.COLS + c] === 1;
  };
}

function rectHitsTile(lookup, x, y, w, h) {
  const c0 = Math.floor(x / PHYS.TILE), c1 = Math.floor((x + w - 0.001) / PHYS.TILE);
  const r0 = Math.floor(y / PHYS.TILE), r1 = Math.floor((y + h - 0.001) / PHYS.TILE);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (lookup(c, r)) return true;
  return false;
}

function overlapCircleRect(cx, cy, cr, rx, ry, rw, rh) {
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy <= cr * cr;
}

/* ---------------------------------- 状态 --------------------------------- */

function createSim(compiled) {
  const dyn = {
    id: compiled.id,
    px: compiled.spawn.x, py: compiled.spawn.y,
    vx: 0, vy: 0,
    gravity: 1,          // 1 = 向下, -1 = 向上
    grounded: false,
    onWall: 0,           // -1 左墙, 1 右墙
    flipCount: 0,
    dead: false, deaths: 0,
    won: false, finished: false, failed: false,
    invuln: 0,
    starsTaken: 0
  };
  const stars = compiled.stars.map(function (s) { return { x: s.x, y: s.y, taken: false }; });
  const state = {
    L: compiled,
    dyn: dyn,
    stars: stars,
    time: 0,
    started: false,
    sawT: 0,
    respawnIn: 0,
    prevJump: false,
    prevFlip: false,
    anim: { x: compiled.spawn.x, y: compiled.spawn.y }
  };
  return state;
}

/* ------------------------------- 内部工具 -------------------------------- */

/**
 * 把玩家从实心块里「最小位移」推出来。
 *
 * 为什么必须有这一步：玩家 AABB 是 24x28，而格子是 40px，所以出生点/走廊
 * 边上很容易出现「只嵌进去几像素」的初始状态。没有脱嵌的话，逐轴碰撞解算
 * 会因为「先被垂直复位、再被水平挡回」来回推导，产生一帧内瞬移 40px 的死循环。
 * 这里按最小重叠轴推开，保证每帧开始时玩家都是合法位置。
 */
function depenetrate(state, lookup) {
  const d = state.dyn;
  const w = PHYS.PW, h = PHYS.PH;
  for (let iter = 0; iter < 6; iter++) {
    const c0 = Math.floor((d.px - w / 2) / PHYS.TILE);
    const c1 = Math.floor((d.px + w / 2 - 0.001) / PHYS.TILE);
    const r0 = Math.floor((d.py - h / 2) / PHYS.TILE);
    const r1 = Math.floor((d.py + h / 2 - 0.001) / PHYS.TILE);
    let best = null;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!lookup(c, r)) continue;
        const left = (c + 1) * PHYS.TILE - (d.px - w / 2);        // 向右推
        const right = (d.px + w / 2) - c * PHYS.TILE;             // 向左推
        const down = (r + 1) * PHYS.TILE - (d.py - h / 2);        // 向下推
        const up = (d.py + h / 2) - r * PHYS.TILE;                // 向上推
        const cands = [
          { axis: 'x', delta: left, dist: left },
          { axis: 'x', delta: -right, dist: right },
          { axis: 'y', delta: down, dist: down },
          { axis: 'y', delta: -up, dist: up }
        ];
        for (const cand of cands) {
          // 只处理「真的重叠」的情况。贴边（重叠 < 0.5px）必须放过，否则
          // 站在地板上会被反复推开，和贴地判定形成拉锯，表现为原地抽搐。
          if (cand.dist <= 0.5) continue;
          if (!best || cand.dist < best.dist) best = cand;
        }
      }
    }
    if (!best) break;
    if (best.axis === 'x') d.px += best.delta + (best.delta > 0 ? 0.01 : -0.01);
    else d.py += best.delta + (best.delta > 0 ? 0.01 : -0.01);
    if (state.trace) console.log('   [depen] ' + best.axis + ' delta=' + best.delta.toFixed(2) + ' -> (' + d.px.toFixed(1) + ',' + d.py.toFixed(1) + ')');
  }
}

function axisMovement(state, axis, delta, lookup) {
  // 逐小步推进；只要这一步会插进实心块，就「撤销这一步并停下」。
  // 早期版本在撤销之后还会用公式重新推算坐标，一旦玩家本来就离格子边界
  // 有偏差（AABB 24x28 放在 40px 格子里很常见），推算就会把人瞬移一整格。
  // 现在只撤销，不再重算，物理行为可预测且不会瞬移。
  //
  // 另外水平碰撞必须把判定盒上下各内缩 2px：玩家高 28px 而地板行高 40px，
  // 站在地板上时脚底会「贴」进地板格一点点，若不内缩，地板本身会被当成
  // 一堵墙，导致角色一迈步就被挡住（无法沿地面行走）。
  const d = state.dyn;
  const w = PHYS.PW, h = PHYS.PH;
  const sign = delta > 0 ? 1 : -1;
  const box = axis === 'x'
    ? { x: d.px - w / 2, y: d.py - h / 2 + PHYS.H_INSET, w: w, h: h - PHYS.H_INSET * 2 }
    : { x: d.px - w / 2, y: d.py - h / 2, w: w, h: h };
  let remain = Math.abs(delta);
  while (remain > 0) {
    const move = Math.min(remain, PHYS.TILE * 0.5);
    remain -= move;
    if (axis === 'x') {
      const old = d.px;
      d.px += sign * move;
      box.x = d.px - w / 2;
      if (rectHitsTile(lookup, box.x, box.y, box.w, box.h)) {
        if (state.trace) console.log('   [x-hit] old=' + old.toFixed(2) + ' -> ' + d.px.toFixed(2) + ' py=' + d.py.toFixed(2) + ' sign=' + sign);
        d.px = old;
        d.vx = 0;
        return true;
      }
    } else {
      const old = d.py;
      d.py += sign * move;
      if (rectHitsTile(lookup, box.x, d.py - h / 2, w, h)) {
        d.py = old;
        d.vy = 0;
        return true;
      }
    }
  }
  return false;
}

function groundCheck(state, lookup) {
  const d = state.dyn;
  const w = PHYS.PW, h = PHYS.PH;
  // 贴地探针：从脚底（贴边，不偏移）向外 8px 的薄片是否碰到实心。
  // 探针必须从 0 偏移开始——如果从「下方 1px」开始，贴边状态下宽度被压到 7px，
  // 就可能探不到地面；而脱嵌逻辑又会认为重叠 0、不再上推，两边就都失效了。
  const probe = 8;
  const top = d.gravity > 0 ? d.py + h / 2 : d.py - h / 2 - probe;
  if (rectHitsTile(lookup, d.px - w / 2 + 2, top, w - 4, probe)) return true;
  return false;
}

function wallCheck(state, lookup) {
  const d = state.dyn;
  const w = PHYS.PW, h = PHYS.PH;
  const r0 = Math.floor((d.py - h / 2 + 3) / PHYS.TILE);
  const r1 = Math.floor((d.py + h / 2 - 3) / PHYS.TILE);
  const lc = Math.floor((d.px - w / 2 - 1) / PHYS.TILE);
  const rc = Math.floor((d.px + w / 2 + 1) / PHYS.TILE);
  let wall = 0;
  for (let r = r0; r <= r1; r++) {
    if (lookup(lc, r)) { wall = -1; break; }
    if (lookup(rc, r)) { wall = 1; break; }
  }
  return wall;
}

function sawPos(saw, t) {
  const span = saw.b - saw.a;
  const period = Math.abs(span) / (saw.speed || 1) * 2;
  const p = period > 0 ? ((t + saw.phase * period) % period) / period : 0;
  const tri = p < 0.5 ? p * 2 : (1 - p) * 2;
  const v = saw.a + span * tri;
  return saw.axis === 'y' ? { x: saw.x, y: v } : { x: v, y: saw.y };
}

function starOverlap(state, s) {
  const d = state.dyn;
  const nx = Math.max(d.px - PHYS.PW / 2, Math.min(s.x, d.px + PHYS.PW / 2));
  const ny = Math.max(d.py - PHYS.PH / 2, Math.min(s.y, d.py + PHYS.PH / 2));
  const dx = s.x - nx, dy = s.y - ny;
  return dx * dx + dy * dy <= 15 * 15;
}

function boxOverlapTileRect(state, tx, ty, tw, th) {
  const d = state.dyn;
  return d.px - PHYS.PW / 2 < tx + tw && d.px + PHYS.PW / 2 > tx &&
         d.py - PHYS.PH / 2 < ty + th && d.py + PHYS.PH / 2 > ty;
}

function kill(state, reason) {
  const d = state.dyn;
  if (d.dead || d.finished || d.won) return;
  d.dead = true;
  d.deaths += 1;
  d.deathReason = reason || 'hit';
  state.respawnIn = PHYS.DEATH_PAUSE;
  if (d.deaths > PHYS.MAX_DEATHS) { d.failed = true; d.finished = true; }
}

function respawn(state) {
  const d = state.dyn;
  d.px = state.L.spawn.x; d.py = state.L.spawn.y;
  d.vx = 0; d.vy = 0;
  d.gravity = 1;
  d.grounded = false;
  d.invuln = PHYS.HURT_INVULN;
  d.dead = false;
  state.anim.x = d.px; state.anim.y = d.py;
}

function finishLevel(state) {
  const d = state.dyn;
  d.won = true;
  d.finished = true;
}

/* --------------------------------- 主步进 -------------------------------- */

/**
 * 推进一步。keys = { left, right, jump, flip }（布尔，flip/jump 为「按下状态」，
 * 内部会做上升沿检测，长按不会连续触发）。
 * dt 固定为 PHYS.DT 时结果完全确定。
 */
function stepSim(state, keys, dt) {
  dt = dt || PHYS.DT;
  const d = state.dyn;
  const L = state.L;
  const lookup = L._lookup || (L._lookup = makeSolidLookup(L));
  const k = keys || {};
  state.sawT += dt;

  if (d.finished) {
    // 结算后仍然让锯子动，便于画面反馈
    return state;
  }

  if (d.dead) {
    state.respawnIn -= dt;
    d.invuln = Math.max(0, d.invuln - dt);
    if (state.respawnIn <= 0 && !d.failed) respawn(state);
    state.prevJump = !!k.jump; state.prevFlip = !!k.flip;
    return state;
  }

  const jumpPressed = !!k.jump && !state.prevJump;
  const flipPressed = !!k.flip && !state.prevFlip;
  state.prevJump = !!k.jump; state.prevFlip = !!k.flip;

  // 第一次「有意图的操作」才开始计时
  if (!state.started && (k.left || k.right || k.jump || k.flip)) state.started = true;
  if (state.started) state.time += dt;

  d.invuln = Math.max(0, d.invuln - dt);
  depenetrate(state, lookup);      // 保证从合法位置开始本帧

  // 1) 重力翻转（瞬切）
  if (flipPressed) {
    d.gravity = -d.gravity;
    d.flipCount++;
    d.grounded = false;
    d.vy = 0;
    if (typeof state.onFlip === 'function') state.onFlip(d);
  }

  // 2) 水平输入
  d.vx = 0;
  if (k.left) d.vx -= PHYS.MOVE_SPEED;
  if (k.right) d.vx += PHYS.MOVE_SPEED;

  // 3) 贴地判定
  const wasGrounded = groundCheck(state, lookup);
  d.grounded = wasGrounded;

  // 4) 跳跃 / 墙跳
  //    用「事实上的贴地」而不是缓存值，这样出生第一帧就按跳也不会被吞掉。
  if (jumpPressed) {
    if (groundCheck(state, lookup)) {
      d.vy = PHYS.JUMP_V * d.gravity;
      d.grounded = true;
    } else {
      const wall = wallCheck(state, lookup);
      if (wall !== 0) {
        d.vy = PHYS.JUMP_V * d.gravity;
        d.vx = wall * PHYS.WALLJUMP_VX;
      }
    }
  }
  d.onWall = wasGrounded ? 0 : wallCheck(state, lookup);

  // 5) 竖直速度
  d.vy += PHYS.GRAVITY * d.gravity * dt;
  if (d.vy > PHYS.MAX_FALL) d.vy = PHYS.MAX_FALL;
  if (d.vy < -PHYS.MAX_FALL) d.vy = -PHYS.MAX_FALL;

  // 6) 移动与碰撞
  if (d.vx !== 0) axisMovement(state, 'x', d.vx * dt, lookup);
  // axisMovement 会把 vy 清零，所以要在调用前先记下「这一帧是不是正朝地面撞」
  const wasMovingIntoGround = d.vy !== 0 && Math.sign(d.vy) === d.gravity;
  const hitV = d.vy !== 0 ? axisMovement(state, 'y', d.vy * dt, lookup) : false;

  // 7) 落地后清竖直速度。贴地判定合并「探针」与「本帧撞地」两路：
  //    只靠探针会因为在格子边界上的舍入而在个别帧抖动，导致贴地标志闪烁。
  if (groundCheck(state, lookup) && (Math.sign(d.vy) === d.gravity || (hitV && wasMovingIntoGround) || d.vy === 0)) {
    d.grounded = true;
    d.vy = 0;
  }

  // 8) 星星
  for (let i = 0; i < state.stars.length; i++) {
    const s = state.stars[i];
    if (!s.taken && starOverlap(state, s)) { s.taken = true; d.starsTaken++; }
  }

  // 9) 尖刺
  for (let i = 0; i < L.spikes.length; i++) {
    const sp = L.spikes[i];
    if (spikeHits(state, sp)) { kill(state, 'spike'); return state; }
  }

  // 10) 锯子
  for (let i = 0; i < L.saws.length; i++) {
    const saw = L.saws[i];
    const p = sawPos(saw, state.sawT);
    if (overlapCircleRect(p.x, p.y, saw.r * 0.9,
        d.px - PHYS.PW / 2, d.py - PHYS.PH / 2, PHYS.PW, PHYS.PH)) {
      kill(state, 'saw'); return state;
    }
  }

  // 11) 出口
  if (d.starsTaken >= state.stars.length) {
    if (boxOverlapTileRect(state, L.exit.x - 18, L.exit.y - 18, 36, 36)) finishLevel(state);
  }

  return state;
}

/** 尖刺按朝向生成一个贴面对齐的判定盒（比视觉略宽容） */
function spikeHits(state, sp) {
  const t = PHYS.TILE;
  const pad = 8;
  let x, y, w, h;
  if (sp.dy === -1) {        // 朝上，装在下方地板
    x = sp.x - t / 2 + 4; y = sp.y + 4; w = t - 8; h = t / 2 + pad;
  } else if (sp.dy === 1) {  // 朝下，装在上方天花板
    x = sp.x - t / 2 + 4; y = sp.y - t / 2 - pad + 8; w = t - 8; h = t / 2 + pad;
  } else if (sp.dx === 1) {  // 朝左，装在右墙
    x = sp.x - t / 2 - pad + 8; y = sp.y - t / 2 + 4; w = t / 2 + pad; h = t - 8;
  } else {                   // 朝右，装在左墙
    x = sp.x + 4; y = sp.y - t / 2 + 4; w = t / 2 + pad; h = t - 8;
  }
  // 判定收紧：把整体向内缩 4px，避免「看着没碰到却死」
  const shrink = 5;
  x += shrink; y += shrink; w -= shrink * 2; h -= shrink * 2;
  return boxOverlapTileRect(state, x, y, w, h);
}

/* ------------------------------ 便捷查询接口 ----------------------------- */

function starsLeft(state) {
  return state.stars.filter(function (s) { return !s.taken; }).length;
}

function isWon(state) { return state.dyn.won === true; }
function isOver(state) { return state.dyn.finished === true; }

/** 3 星判定：时间 <= par.time 且 翻转次数 <= par.flips */
function rateLevel(state) {
  const d = state.dyn;
  if (!d.won) return 0;
  let stars = 1;
  if (state.time <= state.L.par.time) stars++;
  if (d.flipCount <= state.L.par.flips) stars++;
  return stars;
}

/** 把 sim 导出成一个可读取的普通对象（验证器/存档用） */
function snapshot(state) {
  const d = state.dyn;
  return {
    id: d.id, x: d.px, y: d.py, vx: d.vx, vy: d.vy, gravity: d.gravity,
    grounded: d.grounded, flips: d.flipCount, deaths: d.deaths,
    stars: d.starsTaken, time: state.time, won: d.won, failed: d.failed, dead: d.dead
  };
}

const API = {
  PHYS: PHYS, GLYPHS: GLYPHS,
  compileLevel: compileLevel,
  createSim: createSim,
  stepSim: stepSim,
  sawPos: sawPos,
  starsLeft: starsLeft,
  isWon: isWon,
  isOver: isOver,
  rateLevel: rateLevel,
  snapshot: snapshot
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.GF_PHYSICS = API;
