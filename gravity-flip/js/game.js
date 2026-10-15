'use strict';
/* =========================================================================
 * GRAVITY FLIP — 游戏运行时（渲染 / 输入 / 音效 / 关卡流程）
 * 依赖：js/physics.js（GF_PHYSICS）、js/levels.js + js/levels7-12.js（LEVELS_*）
 * 不依赖任何外部库、图片、字体或网络请求。
 * ========================================================================= */

(function () {
  const P = window.GF_PHYSICS;
  if (!P) { console.error('GF_PHYSICS 未加载'); return; }
  const { PHYS, compileLevel, createSim, stepSim, sawPos, starsLeft, rateLevel } = P;

  const LEVELS = []
    .concat(window.GF_LEVELS_1_6 || [])
    .concat(window.GF_LEVELS_7_12 || [])
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);

  const SAVE_KEY = 'gravity-flip-save-v2';
  const W = PHYS.W, H = PHYS.H, T = PHYS.TILE;

  const C = {
    bg: '#05070f', grid: 'rgba(34,211,238,0.045)', tile: '#0b1424',
    tileEdge: '#22d3ee', tileEdgeDim: 'rgba(34,211,238,0.22)',
    spike: '#f472b6', spikeGlow: 'rgba(244,114,182,0.55)',
    star: '#fde047', starGlow: 'rgba(253,224,71,0.5)',
    player: '#67e8f9', playerEdge: '#22d3ee',
    exit: '#4ade80', exitLocked: '#64748b',
    saw: '#fb7185', text: '#e8eefc', dim: 'rgba(232,238,252,0.55)'
  };

  /* ------------------------------ 工具 ------------------------------ */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  function $(id) { return document.getElementById(id); }
  const el = {
    level: $('level'), time: $('time'), flips: $('flips'), stars: $('stars'),
    hint: $('hint'), overlay: $('overlay'), overlayTitle: $('overlay-title'),
    overlayBody: $('overlay-body'), overlayButtons: $('overlay-buttons'),
    canvas: $('game'), pad: $('pad')
  };
  const ctx = el.canvas ? el.canvas.getContext('2d') : null;

  /* ------------------------------ 存档 ------------------------------ */
  const defaultSave = () => ({ v: 2, unlocked: 1, muted: false, best: {} });
  let save = defaultSave();
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') save = Object.assign(defaultSave(), parsed);
    }
  } catch (e) { /* 隐私模式等：静默降级为内存存档 */ }
  function persist() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* 忽略 */ }
  }
  function bestOf(id) { return save.best[id] || { stars: 0, time: null, flips: null }; }

  /* ------------------------------ 音效 ------------------------------ */
  const Sound = (function () {
    let ac = null;
    function ensure() {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ac = new AC();
      }
      if (ac && ac.state === 'suspended') ac.resume();
      return ac;
    }
    function tone(freq, dur, type, gain, slideTo) {
      if (save.muted) return;
      const a = ensure();
      if (!a) return;
      const t0 = a.currentTime;
      const osc = a.createOscillator();
      const g = a.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.06, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(a.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    }
    return {
      unlock: ensure,
      jump() { tone(420, 0.1, 'square', 0.05, 720); },
      flip() { tone(300, 0.16, 'sawtooth', 0.058, 900); },
      land() { tone(180, 0.07, 'triangle', 0.035, 120); },
      star() { tone(880, 0.1, 'sine', 0.07, 1320); },
      die() { tone(300, 0.3, 'sawtooth', 0.08, 60); },
      win() { tone(660, 0.14, 'sine', 0.07, 990); setTimeout(() => tone(990, 0.2, 'sine', 0.07, 1320), 120); },
      fail() { tone(220, 0.4, 'square', 0.07, 70); }
    };
  })();

  /* --------------------------- 静态图层缓存 --------------------------- */
  let bgCache = null, bgCacheId = -1;
  function buildBg(L) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
    // 网格
    g.strokeStyle = C.grid; g.lineWidth = 1;
    for (let x = 0; x <= W; x += T) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
    for (let y = 0; y <= H; y += T) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
    // 实心块
    for (let r = 0; r < PHYS.ROWS; r++) {
      for (let cc = 0; cc < PHYS.COLS; cc++) {
        if (!L.solid[r * PHYS.COLS + cc]) continue;
        const x = cc * T, y = r * T;
        g.fillStyle = C.tile;
        g.fillRect(x, y, T, T);
        g.strokeStyle = C.tileEdgeDim; g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1);
        // 朝空的一面加亮边
        const solidAt = (a, b) => (a < 0 || b < 0 || a >= PHYS.COLS || b >= PHYS.ROWS) ? true : !!L.solid[b * PHYS.COLS + a];
        g.strokeStyle = C.tileEdge; g.lineWidth = 1.5;
        if (!solidAt(cc, r - 1)) { g.beginPath(); g.moveTo(x, y + 1); g.lineTo(x + T, y + 1); g.stroke(); }
        if (!solidAt(cc, r + 1)) { g.beginPath(); g.moveTo(x, y + T - 1); g.lineTo(x + T, y + T - 1); g.stroke(); }
      }
    }
    return c;
  }

  /* ------------------------------ 状态 ------------------------------ */
  const Game = {
    mode: 'menu',              // menu | play | pause | clear | fail | win
    index: 0,
    sim: null,
    shake: 0,
    flash: 0,
    particles: [],
    trail: [],
    accum: 0,
    lastTs: 0,
    hoverBtns: [],
    transition: 0
  };

  const keys = { left: false, right: false, jump: false, flip: false };
  const keyMap = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    Space: 'jump', ArrowUp: 'jump', KeyW: 'jump',
    KeyZ: 'flip', ArrowDown: 'flip', KeyS: 'flip'
  };

  function currentLevel() { return LEVELS[Game.index]; }

  function startLevel(i, keepMode) {
    Game.index = clamp(i, 0, LEVELS.length - 1);
    const L = compileLevel(currentLevel());
    Game.sim = createSim(L);
    Game.sim.onFlip = () => { Sound.flip(); };
    // 关键：重开/切关时清空按键状态。否则上一关残留的 jump/flip=true 会变成
    // stepSim 里的“已按住”，新一关的第一次起跳会被边沿检测吞掉。
    keys.left = keys.right = keys.jump = keys.flip = false;
    Game.shake = 0; Game.flash = 0;
    Game.particles.length = 0; Game.trail.length = 0;
    Game.accum = 0;
    bgCache = buildBg(L); bgCacheId = L.id;
    if (!keepMode) Game.mode = 'play';
    if (el.hint) el.hint.textContent = L.hint || '';
    hideOverlay();
    syncHud();
  }

  function syncHud() {
    const s = Game.sim;
    if (!s) return;
    if (el.level) el.level.textContent = (Game.index + 1) + ' / ' + LEVELS.length;
    if (el.time) el.time.textContent = s.started ? s.time.toFixed(1) : '0.0';
    if (el.flips) el.flips.textContent = String(s.dyn.flipCount);
    if (el.stars) el.stars.textContent = s.dyn.starsTaken + ' / ' + s.stars.length;
  }

  /* ---------------------------- 覆盖层 ---------------------------- */
  function hideOverlay() {
    if (!el.overlay) return;
    el.overlay.hidden = true;
    if (el.overlayButtons) el.overlayButtons.innerHTML = '';
    Game.hoverBtns = [];
  }
  function showOverlay(title, body, buttons) {
    if (!el.overlay) return;
    el.overlay.hidden = false;
    if (el.overlayTitle) el.overlayTitle.textContent = title;
    if (el.overlayBody) el.overlayBody.innerHTML = body;
    el.overlayButtons.innerHTML = '';
    Game.hoverBtns = [];
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ov-btn' + (b.primary ? ' primary' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); b.onClick(); });
      el.overlayButtons.appendChild(btn);
      Game.hoverBtns.push(btn);
    }
  }

  function starIcons(n) {
    return [0, 1, 2].map((i) => `<span class="star ${i < n ? 'on' : ''}">★</span>`).join('');
  }

  function clearLevel() {
    const s = Game.sim;
    const stars = rateLevel(s);
    const L = s.L;
    const prev = bestOf(L.id);
    const nb = {
      stars: Math.max(prev.stars || 0, stars),
      time: prev.time == null ? +s.time.toFixed(2) : Math.min(prev.time, +s.time.toFixed(2)),
      flips: prev.flips == null ? s.dyn.flipCount : Math.min(prev.flips, s.dyn.flipCount)
    };
    save.best[L.id] = nb;
    save.unlocked = Math.max(save.unlocked || 1, Math.min(LEVELS.length, Game.index + 2));
    persist();

    Game.mode = 'clear';
    Sound.win();
    const isLast = Game.index >= LEVELS.length - 1;
    const body =
      `<div class="ov-stars">${starIcons(stars)}</div>` +
      `<div class="ov-row"><span>用时</span><b>${s.time.toFixed(2)}s</b><em>par ${L.par.time}s</em></div>` +
      `<div class="ov-row"><span>翻转</span><b>${s.dyn.flipCount}</b><em>par ${L.par.flips}</em></div>` +
      `<div class="ov-row"><span>死亡</span><b>${s.dyn.deaths}</b><em>上限 3</em></div>` +
      (stars < 3 ? '<div class="ov-tip">三星条件：时间 ≤ par 且 翻转 ≤ par</div>' : '<div class="ov-tip good">完美！</div>');

    const buttons = [];
    if (!isLast) buttons.push({ label: '下一关 →', primary: true, onClick: () => startLevel(Game.index + 1) });
    buttons.push({ label: '重玩本关', onClick: () => startLevel(Game.index) });
    if (isLast) {
      showOverlay('全部通关！', body + '<div class="ov-tip good">12 关全部完成，你已掌握重力反转</div>', buttons);
    } else {
      showOverlay('第 ' + L.id + ' 关 · ' + L.name + ' 通过', body, buttons);
    }
  }

  function failLevel() {
    Game.mode = 'fail';
    Sound.fail();
    const s = Game.sim;
    showOverlay('挑战失败', `<div class="ov-row"><span>死亡次数</span><b>${s.dyn.deaths}</b></div><div class="ov-tip">最多允许 3 次死亡，重来一次吧</div>`, [
      { label: '重试本关', primary: true, onClick: () => startLevel(Game.index) },
      { label: '回到第 1 关', onClick: () => startLevel(0) }
    ]);
  }

  function pauseGame() {
    if (Game.mode !== 'play') return;
    Game.mode = 'pause';
    showOverlay('已暂停', '<div class="ov-tip">按 P 继续 · R 重开本关</div>', [
      { label: '继续', primary: true, onClick: () => resumeGame() },
      { label: '重开本关', onClick: () => startLevel(Game.index) },
      { label: '回到第 1 关', onClick: () => startLevel(0) }
    ]);
  }
  function resumeGame() { if (Game.mode === 'pause') { Game.mode = 'play'; hideOverlay(); } }

  function showMenu() {
    Game.mode = 'menu';
    const unlocked = clamp(save.unlocked || 1, 1, LEVELS.length);
    const totalStars = Object.keys(save.best).reduce((a, k) => a + ((save.best[k] && save.best[k].stars) || 0), 0);
    const body =
      `<div class="ov-tip">按 <b>Z</b>（或 ↓ / S）翻转重力：踩在地面时你会飞向天花板，再按一次飞回地面。</div>` +
      `<div class="ov-tip">集齐 <b>3 颗星</b>后进入出口门。三星 = 时间 ≤ par 且 翻转 ≤ par。</div>` +
      `<div class="ov-row"><span>已解锁</span><b>${unlocked} / ${LEVELS.length}</b></div>` +
      `<div class="ov-row"><span>累计星星</span><b>${totalStars} / ${LEVELS.length * 3}</b></div>`;
    showOverlay('重力反转 GRAVITY FLIP', body, [
      { label: '开始游戏', primary: true, onClick: () => startLevel(Math.min(unlocked - 1, LEVELS.length - 1)) },
      { label: '从头开始', onClick: () => startLevel(0) }
    ]);
  }

  /* ----------------------------- 特效 ----------------------------- */
  function burst(x, y, color, n, power) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.4 + Math.random()) * (power || 260);
      Game.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.35 + Math.random() * 0.45, max: 0.8, color: color, r: 1.5 + Math.random() * 2.6
      });
    }
  }

  /* ----------------------------- 更新 ----------------------------- */
  function update(dt) {
    const s = Game.sim;
    if (!s) return;

    if (Game.mode === 'play') {
      const wasDead = s.dyn.dead, wasWon = s.dyn.won;
      const wasGrounded = s.dyn.grounded;
      const starsBefore = s.dyn.starsTaken;
      stepSim(s, keys, dt);

      if (s.dyn.dead && !wasDead) {
        Game.shake = 12; Game.flash = 0.35;
        Sound.die();
        burst(s.dyn.px, s.dyn.py, C.spike, 26, 300);
      }
      if (!s.dyn.dead && wasDead && s.dyn.invuln > PHYS.HURT_INVULN - 0.05) {
        burst(s.dyn.px, s.dyn.py, C.player, 14, 180);
      }
      if (s.dyn.starsTaken > starsBefore) {
        Sound.star();
        burst(s.dyn.px, s.dyn.py - 12, C.star, 16, 200);
      }
      if (s.dyn.grounded && !wasGrounded && !s.dyn.dead) { Sound.land(); }
      if (s.dyn.won && !wasWon) { clearLevel(); return; }
      if (s.dyn.failed) { failLevel(); return; }

      // 拖尾
      Game.trail.push({ x: s.dyn.px, y: s.dyn.py, life: 0.28 });
      if (Game.trail.length > 40) Game.trail.shift();
    }

    for (let i = Game.trail.length - 1; i >= 0; i--) {
      Game.trail[i].life -= dt;
      if (Game.trail[i].life <= 0) Game.trail.splice(i, 1);
    }
    for (let i = Game.particles.length - 1; i >= 0; i--) {
      const p = Game.particles[i];
      p.life -= dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 900 * dt; p.vx *= 0.985;
      if (p.life <= 0) Game.particles.splice(i, 1);
    }
    Game.shake = Math.max(0, Game.shake - dt * 34);
    Game.flash = Math.max(0, Game.flash - dt * 1.8);
    syncHud();
  }

  /* ----------------------------- 渲染 ----------------------------- */
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawSpike(g, sp) {
    const x = sp.x, y = sp.y, h = T / 2;
    g.save();
    g.shadowColor = C.spikeGlow; g.shadowBlur = 12;
    g.fillStyle = C.spike;
    g.beginPath();
    if (sp.dy === -1) {          // 朝上
      g.moveTo(x - T / 2 + 4, y + T / 2 - 2);
      g.lineTo(x, y + T / 2 - 2 - h - 4);
      g.lineTo(x + T / 2 - 4, y + T / 2 - 2);
    } else if (sp.dy === 1) {    // 朝下
      g.moveTo(x - T / 2 + 4, y - T / 2 + 2);
      g.lineTo(x, y - T / 2 + 2 + h + 4);
      g.lineTo(x + T / 2 - 4, y - T / 2 + 2);
    } else if (sp.dx === 1) {    // 朝左
      g.moveTo(x + T / 2 - 2, y - T / 2 + 4);
      g.lineTo(x + T / 2 - 2 - h - 4, y);
      g.lineTo(x + T / 2 - 2, y + T / 2 - 4);
    } else {                     // 朝右
      g.moveTo(x - T / 2 + 2, y - T / 2 + 4);
      g.lineTo(x - T / 2 + 2 + h + 4, y);
      g.lineTo(x - T / 2 + 2, y + T / 2 - 4);
    }
    g.closePath(); g.fill();
    g.restore();
  }

  function drawStar(g, st, t, taken) {
    if (taken) return;
    const pulse = 1 + Math.sin(t * 4 + st.x * 0.01) * 0.08;
    const r = 15 * pulse;
    g.save();
    g.translate(st.x, st.y);
    g.rotate(t * 0.9);
    g.shadowColor = C.starGlow; g.shadowBlur = 18;
    g.fillStyle = C.star;
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 === 0 ? r : r * 0.45;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      g[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath(); g.fill();
    g.restore();
  }

  function drawExit(g, ex, open, t) {
    const size = 38;
    g.save();
    g.translate(ex.x, ex.y);
    g.shadowColor = open ? 'rgba(74,222,128,0.7)' : 'rgba(100,116,139,0.35)';
    g.shadowBlur = open ? 22 : 8;
    g.strokeStyle = open ? C.exit : C.exitLocked;
    g.lineWidth = 3;
    const pulse = open ? 1 + Math.sin(t * 3) * 0.05 : 1;
    g.scale(pulse, pulse);
    roundRect(g, -size / 2, -size / 2, size, size, 8);
    g.stroke();
    g.globalAlpha = 0.25;
    g.fillStyle = open ? C.exit : C.exitLocked;
    g.fill();
    g.globalAlpha = 1;
    // 内部箭头
    g.beginPath();
    g.moveTo(-7, 0); g.lineTo(7, 0); g.moveTo(3, -5); g.lineTo(8, 0); g.lineTo(3, 5);
    g.stroke();
    g.restore();
  }

  function drawSaw(g, saw, t) {
    const p = sawPos(saw, t);
    g.save();
    g.translate(p.x, p.y);
    g.rotate(t * 6);
    g.shadowColor = 'rgba(251,113,133,0.6)'; g.shadowBlur = 16;
    g.fillStyle = C.saw;
    const teeth = 10, r = saw.r;
    g.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
      const rr = i % 2 === 0 ? r : r * 0.68;
      const a = (Math.PI / teeth) * i;
      g[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath(); g.fill();
    g.fillStyle = C.bg;
    g.beginPath(); g.arc(0, 0, r * 0.32, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  function drawPlayer(g, s, t) {
    const d = s.dyn;
    if (d.dead) return;
    const w = PHYS.PW, h = PHYS.PH;
    const blink = d.invuln > 0 && Math.floor(t * 18) % 2 === 0;
    g.save();
    g.translate(d.px, d.py);
    // 重力方向指示：面朝被吸引的那一侧
    g.rotate(d.gravity > 0 ? 0 : Math.PI);
    if (blink) g.globalAlpha = 0.45;
    g.shadowColor = 'rgba(103,232,249,0.75)'; g.shadowBlur = 20;
    g.fillStyle = C.player;
    roundRect(g, -w / 2, -h / 2, w, h, 6);
    g.fill();
    g.strokeStyle = C.playerEdge; g.lineWidth = 2; g.stroke();
    // 面罩
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(5,7,15,0.8)';
    roundRect(g, -w / 2 + 4, -h / 2 + 5, w - 8, 8, 3);
    g.fill();
    // 脚
    g.fillStyle = C.playerEdge;
    g.fillRect(-w / 2 + 3, h / 2 - 3, 6, 4);
    g.fillRect(w / 2 - 9, h / 2 - 3, 6, 4);
    g.restore();
  }

  function render(t) {
    if (!ctx) return;
    const s = Game.sim;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 屏幕抖动
    let sx = 0, sy = 0;
    if (Game.shake > 0) {
      sx = (Math.random() - 0.5) * Game.shake;
      sy = (Math.random() - 0.5) * Game.shake;
    }
    ctx.save();
    ctx.translate(sx, sy);

    if (s) {
      if (bgCacheId !== s.L.id || !bgCache) { bgCache = buildBg(s.L); bgCacheId = s.L.id; }
      ctx.drawImage(bgCache, 0, 0);

      // 拖尾
      for (const tr of Game.trail) {
        const a = clamp(tr.life / 0.28, 0, 1) * 0.22;
        ctx.globalAlpha = a;
        ctx.fillStyle = C.player;
        roundRect(ctx, tr.x - PHYS.PW / 2, tr.y - PHYS.PH / 2, PHYS.PW, PHYS.PH, 6);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      for (const sp of s.L.spikes) drawSpike(ctx, sp);
      for (const st of s.stars) drawStar(ctx, st, t, st.taken);
      drawExit(ctx, s.L.exit, s.dyn.starsTaken >= s.stars.length, t);
      for (const saw of s.L.saws) drawSaw(ctx, saw, s.sawT);
      drawPlayer(ctx, s, t);

      // 粒子
      for (const p of Game.particles) {
        ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // 死亡闪白
    if (Game.flash > 0) {
      ctx.fillStyle = 'rgba(244,114,182,' + (Game.flash * 0.35) + ')';
      ctx.fillRect(0, 0, W, H);
    }
    // 暗角
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.85);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    ctx.restore();
  }

  /* ----------------------------- 主循环 ----------------------------- */
  function frame(ts) {
    if (!Game.lastTs) Game.lastTs = ts;
    let dt = (ts - Game.lastTs) / 1000;
    Game.lastTs = ts;
    // 防抖：时间戳倒退（页面切回前台/异常时钟）时 dt 可能为负或极大，
    // 直接夹到 [0, 0.1]，避免物理因为负步长反向推进。
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    const t = ts / 1000;

    if (Game.mode === 'play') {
      Game.accum += dt;
      let steps = 0;
      while (Game.accum >= PHYS.DT && steps < 8) { update(PHYS.DT); Game.accum -= PHYS.DT; steps++; }
      if (steps === 0) { /* 等下一帧 */ }
    } else {
      for (const p of Game.particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 900 * dt; }
      for (let i = Game.particles.length - 1; i >= 0; i--) if (Game.particles[i].life <= 0) Game.particles.splice(i, 1);
      Game.shake = Math.max(0, Game.shake - dt * 34);
      Game.flash = Math.max(0, Game.flash - dt * 1.8);
    }
    render(t);
    requestAnimationFrame(frame);
  }

  /* ------------------------------ 输入 ------------------------------ */
  function setKey(name, down) {
    if (keys[name] === down) return;
    keys[name] = down;
    if (down) Sound.unlock();
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat) {
      if (keyMap[e.code]) e.preventDefault();
      return;
    }
    const act = keyMap[e.code];
    if (act) { e.preventDefault(); setKey(act, true); return; }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      e.preventDefault();
      if (Game.mode === 'play') pauseGame(); else if (Game.mode === 'pause') resumeGame();
    } else if (e.code === 'KeyR') {
      e.preventDefault();
      if (Game.mode === 'play' || Game.mode === 'pause' || Game.mode === 'fail') startLevel(Game.index);
    } else if (e.code === 'KeyM') {
      save.muted = !save.muted; persist();
    } else if (e.code === 'Enter') {
      if (Game.mode === 'clear') {
        if (Game.index < LEVELS.length - 1) startLevel(Game.index + 1); else startLevel(Game.index);
      } else if (Game.mode === 'fail') {
        startLevel(Game.index);
      } else if (Game.mode === 'menu') {
        startLevel(Math.min((save.unlocked || 1) - 1, LEVELS.length - 1));
      }
    }
  }, { passive: false });

  window.addEventListener('keyup', (e) => {
    const act = keyMap[e.code];
    if (act) { e.preventDefault(); setKey(act, false); }
  }, { passive: false });

  window.addEventListener('blur', () => {
    keys.left = keys.right = keys.jump = keys.flip = false;
    if (Game.mode === 'play') pauseGame();
  });

  // 触屏/鼠标按钮
  if (el.pad) {
    const bind = (btn) => {
      const act = btn.getAttribute('data-action');
      if (!act) return;
      const down = (e) => { e.preventDefault(); Sound.unlock(); setKey(act, true); btn.classList.add('active'); };
      const up = (e) => { if (e) e.preventDefault(); setKey(act, false); btn.classList.remove('active'); };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    Array.prototype.forEach.call(el.pad.querySelectorAll('button'), bind);
  }

  // 画布点击 = 翻转（移动端便捷操作）
  if (el.canvas) {
    el.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      Sound.unlock();
      if (Game.mode === 'play') { setKey('flip', true); setTimeout(() => setKey('flip', false), 90); }
    });
    el.canvas.addEventListener('pointerup', () => setKey('flip', false));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && Game.mode === 'play') pauseGame();
  });

  /* --------------------------- 画布缩放 --------------------------- */
  function fitCanvas() {
    if (!el.canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.canvas.width = W * dpr;
    el.canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }
  window.addEventListener('resize', () => { fitCanvas(); });

  /* ------------------------------ 启动 ------------------------------ */
  function boot() {
    if (!LEVELS.length) {
      if (el.overlayBody) el.overlayBody.textContent = '关卡数据未加载';
      return;
    }
    fitCanvas();
    // 起始背景
    const L0 = compileLevel(LEVELS[0]);
    Game.sim = createSim(L0);
    bgCache = buildBg(L0); bgCacheId = L0.id;
    showMenu();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 暴露给调试/验证使用
  window.GF_GAME = { Game, LEVELS, startLevel, keys, save, bestOf, PHYS };
})();
