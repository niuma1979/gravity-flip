#!/usr/bin/env node
/**
 * gravity-flip/tools/verify_ui.mjs
 *
 * 独立验证工具（task-3）。零 npm 依赖，只用 node 内置模块。
 *
 * 用法:
 *   node tools/verify_ui.mjs                       # 验证 index.html + README.md（外壳模式）
 *   node tools/verify_ui.mjs --dist dist/gravity-flip.html   # 验证构建产物（自包含）
 *   node tools/verify_ui.mjs --self-test           # 自检：确认检查器不会"空过"
 *   node tools/verify_ui.mjs --style css/style.css # 显式指定 CSS 源（可重复）
 *   node tools/verify_ui.mjs --root <dir>          # 换一个根目录跑（用于负向测试夹具）
 *
 * 退出码: 0 = 全部 PASS; 1 = 存在 FAIL; 2 = 目标文件缺失（无法验证）
 *
 * 本工具只读业务文件；只写 verify/ 下的报告与临时文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const VERIFY_DIR = path.join(PROJECT, 'verify');
const TMP_DIR = path.join(VERIFY_DIR, 'tmp');

const REQUIRED_IDS = ['hud', 'level', 'hint', 'time', 'flips', 'stars', 'overlay', 'overlay-title', 'overlay-body', 'overlay-buttons', 'wrap', 'game'];
const ACTIONS = ['left', 'right', 'jump', 'flip'];

/* ---------------------------------------------------------------- 小工具 */

const R = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', SKIP: 'SKIP' };

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}
function snippet(text, index, len = 90) {
  const start = Math.max(0, index - 20);
  return text.slice(start, index + len).replace(/\s+/g, ' ').trim();
}
function countMatches(text, re) {
  const out = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = r.exec(text)) !== null) {
    out.push({ index: m.index, line: lineOf(text, m.index), text: m[0], groups: m.slice(1) });
    if (m.index === r.lastIndex) r.lastIndex++;
  }
  return out;
}
function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
}
function hasAttr(tag, name) {
  return new RegExp(`\\s${name}(?=[\\s/>])`, 'i').test(tag);
}
/** 取某 id 元素的内部文本（去标签） */
function innerTextOf(html, id) {
  const m = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i').exec(html);
  return m ? m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
}
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** 真实字节数（注意 String.length 是 UTF-16 码元数，中文会偏小，不能当字节数） */
function bytes(text) {
  return Buffer.byteLength(String(text), 'utf8');
}
/** 把 CSS 注释替换为等长空白（保留换行），避免注释里的 @import/url/<style> 造成误判且不破坏行号 */
function stripCssComments(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/* -------------------------------------------------------- 结构检查核心 */

/**
 * @param {string} html        待检查的 HTML 文本
 * @param {{name:string,text:string}[]} cssSources  CSS 来源（内联 style + 外部 css 文件）
 * @param {{template:boolean}} opts template=true 时要求占位符存在（外壳模式）
 */
function checkTemplate(html, cssSources, opts = {}) {
  const res = [];
  const add = (id, title, status, detail, evidence) => res.push({ id, title, status, detail, evidence: evidence || '' });
  const cssText = stripCssComments(cssSources.map((s) => s.text).join('\n'));

  /* 1. 占位符 ------------------------------------------------ */
  const stylePh = countMatches(html, /<!--@STYLE@-->/g);
  const bundlePh = countMatches(html, /<!--@BUNDLE@-->/g);
  if (opts.template) {
    add('1.1', '`<!--@STYLE@-->` 恰好 1 次', stylePh.length === 1 ? R.PASS : R.FAIL,
      `实际 ${stylePh.length} 次` + (stylePh.length ? `，行号 ${stylePh.map((m) => m.line).join(',')}` : ''));
    add('1.2', '`<!--@BUNDLE@-->` 恰好 1 次', bundlePh.length === 1 ? R.PASS : R.FAIL,
      `实际 ${bundlePh.length} 次` + (bundlePh.length ? `，行号 ${bundlePh.map((m) => m.line).join(',')}` : ''));
  } else {
    add('1.1', '构建产物无 `<!--@STYLE@-->` 残留', stylePh.length === 0 ? R.PASS : R.FAIL, `实际 ${stylePh.length} 次`);
    add('1.2', '构建产物无 `<!--@BUNDLE@-->` 残留', bundlePh.length === 0 ? R.PASS : R.FAIL, `实际 ${bundlePh.length} 次`);
  }
  const strayStyleOpen = countMatches(html, /<style[\s>]/gi);
  const strayStyleClose = countMatches(html, /<\/style>/gi);
  const strayScriptOpen = countMatches(html, /<script[\s>]/gi);
  const strayScriptClose = countMatches(html, /<\/script>/gi);
  const strayTotal = strayStyleOpen.length + strayStyleClose.length + strayScriptOpen.length + strayScriptClose.length;
  // 外壳模式：模板里除占位符外不得有 <style>/<script>；产物模式：必须有内联 style/script
  if (opts.template) {
    add('1.3', '模板内除占位符外无其他 <style>/<script> 标签', strayTotal === 0 ? R.PASS : R.FAIL,
      strayTotal === 0 ? '<style>/<script> 计数均为 0'
        : `style开=${strayStyleOpen.length}(行 ${strayStyleOpen.map((m) => m.line).join(',') || '-'}) style闭=${strayStyleClose.length} script开=${strayScriptOpen.length}(行 ${strayScriptOpen.map((m) => m.line).join(',') || '-'}) script闭=${strayScriptClose.length}`);
  } else {
    const scriptBlocks = countMatches(html, /<script\b[^>]*>[\s\S]*?<\/script>/gi);
    const styleBlocks = countMatches(html, /<style\b[^>]*>[\s\S]*?<\/style>/gi);
    add('1.3', '构建产物存在内联 <style> 与 <script>', (styleBlocks.length >= 1 && scriptBlocks.length >= 1) ? R.PASS : R.FAIL,
      `内联 style 块=${styleBlocks.length}（行 ${styleBlocks.map((m) => m.line).join(',') || '-'}），script 块=${scriptBlocks.length}（行 ${scriptBlocks.map((m) => m.line).join(',') || '-'}）`);
  }

  /* 2. 必需 id ----------------------------------------------- */
  const idTags = countMatches(html, /<([a-zA-Z][\w-]*)\b[^>]*?\bid\s*=\s*["']([^"']+)["'][^>]*>/g)
    .map((m) => ({ id: attr(m.text, 'id'), tag: m.groups[0], line: m.line, raw: m.text }));
  const idMap = new Map();
  for (const t of idTags) {
    if (!idMap.has(t.id)) idMap.set(t.id, []);
    idMap.get(t.id).push(t);
  }
  const missing = REQUIRED_IDS.filter((id) => !idMap.has(id));
  const idEvidence = REQUIRED_IDS.filter((id) => idMap.has(id))
    .map((id) => `${id}@L${idMap.get(id)[0].line}<${idMap.get(id)[0].tag}>`).join(' ');
  add('2.1', `必需 id 全部存在（${REQUIRED_IDS.length} 个）`, missing.length === 0 ? R.PASS : R.FAIL,
    missing.length === 0 ? `全部命中；共发现 ${idMap.size} 个 id`
      : `缺失 ${missing.length} 个: ${missing.join(', ')}`, idEvidence);
  const dupIds = [...idMap.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => `${k}(行 ${v.map((x) => x.line).join(',')})`);
  add('2.2', '无重复 id', dupIds.length === 0 ? R.PASS : R.FAIL, dupIds.length ? `重复: ${dupIds.join('; ')}` : '无重复');
  // 显式对「本文件文本」逐个 id 计数（不依赖模板路径的任何结论）
  const notOnce = REQUIRED_IDS.map((id) => ({ id, n: (idMap.get(id) || []).length })).filter((x) => x.n !== 1);
  add('2.3', `每个必需 id 恰好 1 次（在${opts.template ? '模板' : '产物'}文本中独立计数）`, notOnce.length === 0 ? R.PASS : R.FAIL,
    notOnce.length === 0 ? `12/12 个必需 id 计数均为 1；本文本共 ${idTags.length} 个 id 标签`
      : notOnce.map((x) => `${x.id}×${x.n}`).join(', '),
    `计数对象 = 本文本自身（${opts.template ? '模板 index.html' : '产物'}），sha256=${sha256(html).slice(0, 12)}… ${bytes(html)}B`);

  /* 3. 四个操作按钮 ------------------------------------------- */
  const buttonTags = countMatches(html, /<button\b[^>]*>/gi).map((m) => ({ ...m, action: attr(m.text, 'data-action'), type: attr(m.text, 'type') }));
  const btnProblems = [];
  for (const a of ACTIONS) {
    const matches = buttonTags.filter((b) => b.action === a);
    if (matches.length !== 1) {
      btnProblems.push(`data-action="${a}" 出现 ${matches.length} 次（应为 1）`);
      continue;
    }
    const b = matches[0];
    if ((b.type || '').toLowerCase() !== 'button') btnProblems.push(`data-action="${a}" (行 ${b.line}) 的 type=${JSON.stringify(b.type)}，应为 "button"`);
  }
  add('3.1', '四个操作按钮存在且 type="button"', btnProblems.length === 0 ? R.PASS : R.FAIL,
    btnProblems.length ? btnProblems.join(' | ') : `共 ${buttonTags.length} 个 <button>，四个 action 各 1 个且 type="button"`,
    buttonTags.map((b) => `L${b.line} action=${b.action ?? '(无)'} type=${b.type ?? '(无)'}`).join('; '));

  const taMatches = countMatches(cssText, /touch-action\s*:\s*none/gi);
  const taInButtonRule = countMatches(cssText, /([^{}]*)\{[^{}]*touch-action\s*:\s*none[^{}]*\}/gi)
    .map((m) => ({ sel: (m.groups[0] || '').replace(/\s+/g, ' ').trim(), line: m.line }));
  const taSelOk = taInButtonRule.some((r) => /button|\.btn|action/i.test(r.sel));
  add('3.2', 'CSS 含 `touch-action:none` 且作用于按钮', taMatches.length === 0 ? R.FAIL : (taSelOk ? R.PASS : R.WARN),
    taMatches.length === 0 ? 'CSS 中未找到 touch-action:none'
      : `命中 ${taMatches.length} 处；按钮相关规则: ${taInButtonRule.map((r) => `L${r.line} "${r.sel}"`).join(', ') || '无（选择器未提及 button/.btn/action）'}`,
    taInButtonRule.map((r) => `L${r.line} ${r.sel}`).join(' | '));

  /* 4. canvas ------------------------------------------------ */
  const canvasTags = countMatches(html, /<canvas\b[^>]*>/gi);
  const gameCanvas = canvasTags.find((m) => attr(m.text, 'id') === 'game');
  let cvDetail;
  let cvStatus;
  if (!gameCanvas) {
    cvStatus = R.FAIL;
    cvDetail = canvasTags.length === 0 ? '未找到任何 <canvas>' : `找到 ${canvasTags.length} 个 <canvas> 但无 id="game"`;
  } else {
    const w = attr(gameCanvas.text, 'width');
    const h = attr(gameCanvas.text, 'height');
    const ok = w === '1280' && h === '720';
    cvStatus = ok ? R.PASS : R.FAIL;
    cvDetail = `L${gameCanvas.line} ${gameCanvas.text.trim()} → width=${JSON.stringify(w)} height=${JSON.stringify(h)}`;
  }
  add('4.1', '<canvas id="game" width="1280" height="720">', cvStatus, cvDetail,
    gameCanvas ? `L${gameCanvas.line}` : canvasTags.map((m) => `L${m.line} ${m.text.trim()}`).join(' | '));

  const arMatches = countMatches(cssText, /([^{}]*)\{([^{}]*aspect-ratio\s*:\s*16\s*\/\s*9[^{}]*)\}/gi);
  const ar169 = arMatches.length > 0;
  const maxW = countMatches(cssText, /max-width\s*:/gi);
  const maxH = countMatches(cssText, /max-height\s*:/gi);
  const scopeOk = arMatches.some((m) => /canvas|#game|#wrap|\.wrap|\.stage|\.game/i.test(m.groups[0] || ''));
  let ratioStatus, ratioDetail;
  if (ar169) {
    ratioStatus = scopeOk ? R.PASS : R.WARN;
    ratioDetail = `找到 aspect-ratio:16/9（${arMatches.map((m) => `L${m.line} "${(m.groups[0] || '').replace(/\s+/g, ' ').trim()}"`).join(', ')}）` + (scopeOk ? '，选择器指向 canvas/#game/#wrap' : '，但选择器未明确指向 canvas/#game/#wrap，需人工确认');
  } else if (maxW.length && maxH.length) {
    ratioStatus = R.WARN;
    ratioDetail = `未找到 aspect-ratio:16/9；找到 max-width(${maxW.length} 处, 行 ${maxW.map((m) => m.line).join(',')}) + max-height(${maxH.length} 处, 行 ${maxH.map((m) => m.line).join(',')})，需人工确认是否保持 16:9 且不裁切`;
  } else {
    ratioStatus = R.FAIL;
    ratioDetail = `既无 aspect-ratio:16/9，也无 max-width+max-height 组合（max-width=${maxW.length} max-height=${maxH.length}）`;
  }
  add('4.2', 'CSS 保证 16:9 且不裁切', ratioStatus, ratioDetail);

  const crop = countMatches(cssText, /object-fit\s*:\s*cover|clip-path\s*:/gi);
  add('4.3', 'CSS 无 object-fit:cover / clip-path 裁切迹象', crop.length === 0 ? R.PASS : R.WARN,
    crop.length ? `命中: ${crop.map((m) => `L${m.line} ${m.text}`).join(', ')}` : '未发现');

  /* 5. overlay 默认 hidden ------------------------------------ */
  const overlayTags = idTags.filter((t) => t.id === 'overlay');
  const overlayTag = overlayTags[0];
  const hidden = overlayTag ? hasAttr(overlayTag.raw, 'hidden') : false;
  add('5.1', '#overlay 默认带 hidden', hidden ? R.PASS : R.FAIL,
    overlayTag ? `L${overlayTag.line} ${overlayTag.raw.replace(/\s+/g, ' ').trim()}` : '未找到 id="overlay" 的元素');

  // hidden 属性会被自定义 display 覆盖：必须存在 #overlay[hidden]{display:none}
  const cssRules = countMatches(cssText, /([^{}]+)\{([^{}]*)\}/g).map((m) => ({ sel: (m.groups[0] || '').replace(/\s+/g, ' ').trim(), body: m.groups[1] || '', line: m.line }));
  const ovRules = cssRules.filter((r) => /#overlay\b/.test(r.sel));
  const ovDisplayOn = ovRules.filter((r) => /display\s*:\s*(?!none)/i.test(r.body));
  const ovHiddenOverride = ovRules.filter((r) => /\[hidden\]/.test(r.sel) && /display\s*:\s*none/i.test(r.body));
  let hStatus, hDetail;
  if (ovHiddenOverride.length) {
    hStatus = R.PASS;
    hDetail = `存在覆盖规则: ${ovHiddenOverride.map((r) => `L${r.line} "${r.sel}"`).join(', ')}`;
  } else if (ovDisplayOn.length) {
    hStatus = R.FAIL;
    hDetail = `#overlay 被 CSS 设为 display≠none（${ovDisplayOn.map((r) => `L${r.line} "${r.sel}" {${r.body.trim().slice(0, 40)}}`).join(', ')}）但没有 #overlay[hidden]{display:none} 覆盖规则 → hidden 属性会被覆盖，overlay 无法隐藏`;
  } else {
    hStatus = R.WARN;
    hDetail = '未找到 #overlay 的 display 规则，也未找到 [hidden] 覆盖规则；依赖 UA 默认样式，需人工确认';
  }
  add('5.2', '#overlay 的 hidden 实际生效（CSS 不覆盖）', hStatus, hDetail);

  /* 1.4 模板不得引用任何外部资源 ------------------------------- */
  if (opts.template) {
    const bad = [];
    for (const m of html.matchAll(/\b(src|href)\s*=\s*(["'])(.*?)\2/gi)) {
      const v = m[3].trim();
      if (!(v === '' || v.startsWith('#') || /^data:/i.test(v))) bad.push(`L${lineOf(html, m.index)} ${m[1]}="${v.slice(0, 60)}"`);
    }
    for (const s of cssSources) {
      const clean = stripCssComments(s.text);
      for (const m of clean.matchAll(/@import\b[^;]*|url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
        const v = (m[2] || '').trim();
        if (/@import/i.test(m[0]) || !/^data:/i.test(v)) bad.push(`${s.name} L${lineOf(clean, m.index)} ${m[0].slice(0, 60)}`);
      }
    }
    add('1.4', '模板与 CSS 无外部资源引用（src/href/@import/url）', bad.length === 0 ? R.PASS : R.FAIL,
      bad.length === 0 ? '未发现外部引用（为最终自包含产物做好准备）' : `发现 ${bad.length} 处: ${bad.join('; ')}`);
  }

  return res;
}

/* ------------------------------------------------------- README 检查核心 */

const KEY_CANON = [
  { canon: 'ArrowLeft', aliases: ['arrowleft', 'left', '←', '⟵', '◀', '左'] },
  { canon: 'ArrowRight', aliases: ['arrowright', 'right', '→', '⟶', '▶', '右'] },
  { canon: 'ArrowUp', aliases: ['arrowup', 'up', '↑', '▲', '上'] },
  { canon: 'ArrowDown', aliases: ['arrowdown', 'down', '↓', '▼', '下'] },
  { canon: 'KeyA', aliases: ['keya', 'a'] },
  { canon: 'KeyD', aliases: ['keyd', 'd'] },
  { canon: 'KeyW', aliases: ['keyw', 'w'] },
  { canon: 'KeyS', aliases: ['keys', 's'] },
  { canon: 'KeyZ', aliases: ['keyz', 'z'] },
  { canon: 'KeyX', aliases: ['keyx', 'x'] },
  { canon: 'KeyR', aliases: ['keyr', 'r'] },
  { canon: 'KeyP', aliases: ['keyp', 'p'] },
  { canon: 'KeyM', aliases: ['keym'] },
  { canon: 'Space', aliases: ['space', 'spacebar', '空格', '␣', ' '] },
  { canon: 'Shift', aliases: ['shift', 'shiftleft', 'shiftright', 'shift键'] },
  { canon: 'Escape', aliases: ['escape', 'esc'] },
  { canon: 'Enter', aliases: ['enter', '回车'] },
];
const KEYCODE_MAP = { 32: 'Space', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 65: 'KeyA', 68: 'KeyD', 83: 'KeyS', 87: 'KeyW', 88: 'KeyX', 90: 'KeyZ', 16: 'Shift', 27: 'Escape', 13: 'Enter' };

function canonKeys(raw) {
  const out = [];
  const clean = String(raw).replace(/^`+|`+$/g, '').replace(/<[^>]+>/g, '');
  const tryOne = (t) => {
    if (!t) return;
    const hit = KEY_CANON.find((k) => k.aliases.includes(t));
    if (hit && !out.includes(hit.canon)) out.push(hit.canon);
  };
  // 注意：`' '`（空格键）在 trim/按空白切分后会被抹掉，必须先单独判定
  if (clean === ' ' || /^\s+$/.test(clean)) { tryOne(' '); return out; }
  const whole = clean.trim().toLowerCase();
  tryOne(whole);
  if (out.length === 0) {
    for (const piece of whole.split(/[\/+,|]|\s+或\s+/)) tryOne(piece.trim());
  }
  return out;
}
function normalizeAction(s) {
  return s.replace(/<[^>]+>/g, '').replace(/[`*_|]/g, '').replace(/[（(].*?[)）]/g, '').replace(/[\s:：,，。.、\-—>→]+/g, '').trim();
}
/** 动作语义归类：用于判断「同一个键是否被写成两个不同动作」 */
function actionClass(text) {
  const t = String(text);
  if (/左|left/i.test(t)) return 'left';
  if (/右|right/i.test(t)) return 'right';
  if (/跳|jump/i.test(t)) return 'jump';
  if (/翻|flip|重力/i.test(t)) return 'flip';
  if (/暂停|pause/i.test(t)) return 'pause';
  if (/重开|重来|重启|restart|retry/i.test(t)) return 'restart';
  return 'other';
}
/** 从页面内 #hint 文本提取按键声明（形如 `←/→ 或 A/D 移动 · Space/↑/W 跳`） */
const HINT_KEY_RE = /ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Space|Shift(?:Left|Right)?|Esc(?:ape)?|Enter|←|→|↑|↓|◀|▶|空格|(?<![A-Za-z])(?:A|D|W|S|Z|X|P|R)(?![A-Za-z])/g;
function hintClaims(hintText) {
  const claims = [];
  const segments = String(hintText).split(/[·|;；]|\s{2,}/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const keys = [...new Set((seg.match(HINT_KEY_RE) || []).flatMap((t) => canonKeys(t)))];
    if (!keys.length) continue;
    const action = normalizeAction(seg.replace(HINT_KEY_RE, ' '));
    claims.push({ keys, action, actionClass: actionClass(seg), raw: seg });
  }
  return claims;
}
/** 从 README 提取 (keys[], actionText, line) 声明 */
function readmeClaims(readme) {
  const claims = [];
  const lines = readme.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|/.test(line)) {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '');
      if (cells.length < 2 || cells.every((c) => /^[-: ]+$/.test(c))) continue;
      let keys = [];
      const texts = [];
      for (const c of cells) {
        const k = canonKeys(c.replace(/`/g, ''));
        if (k.length) keys = keys.concat(k);
        else texts.push(c);
      }
      if (keys.length) claims.push({ keys: [...new Set(keys)], action: texts.join(' ') || '(空)', line: i + 1, raw: line.trim() });
      continue;
    }
    // <kbd> 与反引号 token
    const tokens = [];
    for (const m of line.matchAll(/<kbd>\s*([^<]*?)\s*<\/kbd>/gi)) tokens.push(m[1]);
    for (const m of line.matchAll(/`([^`\n]{1,14})`/g)) tokens.push(m[1]);
    let keys = [];
    for (const t of tokens) keys = keys.concat(canonKeys(t));
    keys = [...new Set(keys)];
    if (keys.length) {
      let action = line;
      for (const t of tokens) action = action.split('`' + t + '`').join('').split('<kbd>' + t + '</kbd>').join('');
      action = normalizeAction(action);
      claims.push({ keys, action: action || '(空)', line: i + 1, raw: line.trim() });
    }
  }
  return claims;
}
/** 从 js 源码提取实际绑定的按键（canonical） */
function jsBindings(jsText) {
  const found = new Map(); // canon -> 行号
  const table = new Map(); // canon -> Set(动作名)，来自对象字面量键表
  const push = (canon, line) => { if (canon && !found.has(canon)) found.set(canon, line); };
  const scan = (re, grab) => {
    for (const m of jsText.matchAll(re)) {
      const line = lineOf(jsText, m.index);
      for (const c of grab(m)) push(c, line);
    }
  };
  scan(/\.key\s*===?\s*(["'])(.*?)\1/g, (m) => canonKeys(m[2]));
  scan(/\.code\s*===?\s*(["'])(.*?)\1/g, (m) => canonKeys(m[2]));
  scan(/case\s+(["'])(.*?)\1\s*:/g, (m) => canonKeys(m[2]));
  scan(/(["'])(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Space|Spacebar|Key[A-Z]|ShiftLeft|ShiftRight|Escape|Enter)\1/g, (m) => canonKeys(m[2]));
  scan(/keyCode\s*===?\s*(\d+)/g, (m) => (KEYCODE_MAP[m[1]] ? [KEYCODE_MAP[m[1]]] : []));
  // 对象字面量键表：ArrowLeft: 'left', KeyA: 'left'（键名不带引号或带引号都要认）
  for (const m of jsText.matchAll(/(?:^|[{,\s])(["']?)(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Space|Spacebar|Key[A-Z]|ShiftLeft|ShiftRight|Escape|Enter)\1\s*:\s*(["'])([^"']*)\3/gm)) {
    const line = lineOf(jsText, m.index);
    for (const c of canonKeys(m[2])) {
      push(c, line);
      if (!table.has(c)) table.set(c, new Set());
      table.get(c).add(m[4]);
    }
  }
  const dynamic = /\.key\s*\.\s*toLowerCase\(\)|\.key\s*\.\s*toUpperCase\(\)/.test(jsText);
  return { found, dynamic, table };
}

function checkReadme(readme, jsTexts, hintText) {
  const res = [];
  const add = (id, title, status, detail, evidence) => res.push({ id, title, status, detail, evidence: evidence || '' });
  const claims = readmeClaims(readme);

  // 仅统计「能识别出动作语义」的声明，避免把普通叙述误判为冲突
  const actionMap = new Map(); // canon -> Set(actionClass)
  let skipped = 0;
  for (const c of claims) {
    const cls = actionClass(c.action);
    if (cls === 'other') { skipped++; continue; }
    for (const k of c.keys) {
      if (!actionMap.has(k)) actionMap.set(k, new Set());
      actionMap.get(k).add(cls);
    }
  }
  const contradictions = [...actionMap.entries()].filter(([, v]) => v.size > 1);
  add('7.1', 'README 自身无自相矛盾（同键不映射到多个动作）', contradictions.length === 0 ? R.PASS : R.FAIL,
    contradictions.length === 0
      ? `解析到 ${claims.length} 条按键声明（${skipped} 条无动作语义、已跳过），无冲突`
      : contradictions.map(([k, v]) => `${k} → [${[...v].join(' / ')}]`).join('; '),
    claims.map((c) => `L${c.line} {${c.keys.join(',')}} => ${c.action.slice(0, 40)}`).join(' | '));

  add('7.2', 'README 提到四个动作（左/右/跳/翻）', (() => {
    const t = readme;
    const missing = [];
    if (!/(左|left)/i.test(t)) missing.push('左/left');
    if (!/(右|right)/i.test(t)) missing.push('右/right');
    if (!/(跳|jump)/i.test(t)) missing.push('跳/jump');
    if (!/(翻|flip|重力)/i.test(t)) missing.push('翻/flip');
    return missing.length === 0 ? R.PASS : R.WARN;
  })(), (() => {
    const missing = [];
    if (!/(左|left)/i.test(readme)) missing.push('左/left');
    if (!/(右|right)/i.test(readme)) missing.push('右/right');
    if (!/(跳|jump)/i.test(readme)) missing.push('跳/jump');
    if (!/(翻|flip|重力)/i.test(readme)) missing.push('翻/flip');
    return missing.length ? `README 未提及: ${missing.join(', ')}` : '四个动作均有提及';
  })());

  const allJs = jsTexts.map((j) => j.text).join('\n');
  const js = jsBindings(allJs);
  if (!allJs.trim() || js.found.size === 0) {
    add('7.3', 'README 按键 vs 脚本实际绑定一致', R.SKIP,
      `未找到任何 JS 按键绑定（扫描文件: ${jsTexts.map((j) => j.name).join(', ') || '无'}），无法比对——需在脚本落地后重跑`);
  } else {
    const documented = new Set([...actionMap.keys()]);
    const bound = new Set([...js.found.keys()]);
    const docNotBound = [...documented].filter((k) => !bound.has(k));
    const boundNotDoc = [...bound].filter((k) => !documented.has(k));
    // 语义比对：对键表里带动作名的键，README 的动作语义必须与代码一致
    const semProblems = [];
    for (const [k, acts] of js.table) {
      const docCls = actionMap.get(k);
      if (!docCls) continue;
      const codeCls = new Set([...acts].map(actionClass));
      if (codeCls.size === 1 && !docCls.has([...codeCls][0])) {
        semProblems.push(`${k}: README=[${[...docCls].join(',')}] 代码键表=[${[...codeCls].join(',')}]`);
      }
    }
    const status = (docNotBound.length || semProblems.length) ? R.FAIL : (boundNotDoc.length ? R.WARN : R.PASS);
    add('7.3', 'README 按键 vs 脚本实际绑定一致', status,
      `README 声明=[${[...documented].join(',')}] 脚本绑定=[${[...bound].join(',')}]`
      + (docNotBound.length ? ` | FAIL: README 声明但脚本未绑定: ${docNotBound.join(',')}` : '')
      + (semProblems.length ? ` | FAIL: 键表语义不一致: ${semProblems.join('; ')}` : '')
      + (boundNotDoc.length ? ` | WARN: 脚本绑定但 README 未写: ${boundNotDoc.join(',')}（属界面/便利键，建议补进 README）` : '')
      + (js.dynamic ? ' | 注意: 脚本存在 .key.toLowerCase() 等动态处理，静态解析可能不全' : ''),
      `键表(带动作)=${[...js.table.entries()].map(([k, v]) => `${k}→${[...v].join('/')}`).join(' ')} | 其余绑定=${[...js.found.entries()].filter(([k]) => !js.table.has(k)).map(([k, l]) => `${k}@L${l}`).join(' ')}`);
  }

  /* 7.4 页面 #hint 与 README 的一致性 */
  if (!hintText) {
    add('7.4', '页面 #hint 与 README 操作说明一致', R.SKIP, '未在 HTML 中找到 #hint 文本，无法比对');
  } else {
    const h = hintClaims(hintText);
    const hintKeys = new Set(h.flatMap((c) => c.keys));
    const docKeys = new Set(claims.flatMap((c) => c.keys));
    const problems = [];
    for (const c of h) {
      const docCls = new Set(c.keys.map((k) => actionMap.get(k)).filter(Boolean).flatMap((s) => [...s]));
      if (c.actionClass === 'other') {
        if (docCls.size > 1) problems.push(`提示段 "${c.raw}" 合并了多个动作 [${[...docCls].join(',')}]，无法机器判定（人工确认）`);
        continue;
      }
      if (docCls.size && !docCls.has(c.actionClass)) {
        problems.push(`提示段 "${c.raw}" 表示 ${c.actionClass}，但 README 对 ${c.keys.join('/')} 写的是 [${[...docCls].join(',')}]`);
      }
    }
    const onlyHint = [...hintKeys].filter((k) => !docKeys.has(k));
    const onlyDoc = [...docKeys].filter((k) => !hintKeys.has(k));
    if (onlyHint.length) problems.push(`#hint 有但 README 没有的键: ${onlyHint.join(',')}`);
    if (onlyDoc.length) problems.push(`README 有但 #hint 没有的键: ${onlyDoc.join(',')}`);
    const hard = problems.filter((p) => !p.includes('人工确认'));
    add('7.4', '页面 #hint 与 README 操作说明一致', hard.length ? R.FAIL : (problems.length ? R.WARN : R.PASS),
      problems.length ? problems.join(' | ') : `#hint 键集 = README 键集 = [${[...hintKeys].join(',')}]，各提示段动作语义一致`,
      h.map((c) => `{${c.keys.join(',')}} => ${c.actionClass}("${c.raw.slice(0, 30)}")`).join(' | '));
  }
  return res;
}

/* --------------------------------------------------------- 产物自包含检查 */

function checkDist(distText, cssSources, opts = {}) {
  const checks = [];

  // 外部引用
  const urlRefs = [];
  for (const m of distText.matchAll(/\b(src|href)\s*=\s*(["'])(.*?)\2/gi)) {
    const val = m[3].trim();
    const ok = val === '' || val.startsWith('#') || /^data:/i.test(val);
    urlRefs.push({ attr: m[1].toLowerCase(), value: val, line: lineOf(distText, m.index), ok });
  }
  const badRefs = urlRefs.filter((r) => !r.ok);
  checks.push({
    id: 'D1', title: '无外部 src=/href= 请求（仅允许 # 锚点与 data: 内联）',
    status: badRefs.length === 0 ? 'PASS' : 'FAIL',
    detail: badRefs.length === 0 ? `检查 ${urlRefs.length} 个 src/href，全部为 # 或 data:`
      : `发现 ${badRefs.length} 个外部引用: ` + badRefs.map((r) => `L${r.line} ${r.attr}="${r.value.slice(0, 80)}"`).join('; '),
    evidence: urlRefs.map((r) => `L${r.line} ${r.attr}="${r.value.slice(0, 40)}"`).join(' '),
  });

  // http(s) 链接
  const httpMatches = [...distText.matchAll(/https?:\/\/[^\s"'<>)\\]*/gi)].map((m) => ({ line: lineOf(distText, m.index), url: m[0], ctx: snippet(distText, m.index, 60) }));
  const nsOnly = httpMatches.filter((m) => /w3\.org/i.test(m.url) && /xmlns|xlink/i.test(m.ctx));
  const realHttp = httpMatches.filter((m) => !nsOnly.includes(m));
  checks.push({
    id: 'D2', title: '无 http(s) 外部链接（w3.org 命名空间声明除外）',
    status: realHttp.length === 0 ? (nsOnly.length ? 'WARN' : 'PASS') : 'FAIL',
    detail: realHttp.length ? `发现 ${realHttp.length} 个 http(s) 链接: ` + realHttp.map((m) => `L${m.line} ${m.url}`).join('; ')
      : (nsOnly.length ? `仅 ${nsOnly.length} 个 XML 命名空间声明（非网络请求）: ` + nsOnly.map((m) => `L${m.line} ${m.url}`).join('; ') : '未发现任何 http(s)'),
    evidence: httpMatches.map((m) => `L${m.line} ${m.url}`).join(' '),
  });

  // 占位符残留
  const leftovers = ['<!--@STYLE@-->', '<!--@BUNDLE@-->', '@STYLE@', '@BUNDLE@']
    .map((t) => ({ token: t, hits: countMatches(distText, new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) }))
    .filter((x) => x.hits.length);
  checks.push({
    id: 'D3', title: '占位符已被替换干净', status: leftovers.length === 0 ? 'PASS' : 'FAIL',
    detail: leftovers.length === 0 ? '4 种占位符 token 均为 0 次'
      : leftovers.map((x) => `${x.token} × ${x.hits.length}（行 ${x.hits.map((h) => h.line).join(',')}）`).join('; '),
    evidence: '',
  });

  // CSS url() 外部资源（忽略注释）
  const cssUrls = [];
  for (const src of cssSources) {
    const clean = stripCssComments(src.text);
    for (const m of clean.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
      if (!/^data:/i.test(m[2].trim())) cssUrls.push({ src: src.name, line: lineOf(clean, m.index), value: m[2] });
    }
  }
  checks.push({
    id: 'D4', title: '内联 CSS 无外部 url() 资源', status: cssUrls.length === 0 ? 'PASS' : 'FAIL',
    detail: cssUrls.length === 0 ? `扫描 ${cssSources.length} 个样式源，无外部 url()`
      : cssUrls.map((u) => `${u.src} L${u.line} url(${u.value.slice(0, 60)})`).join('; '),
    evidence: '',
  });

  // 内联脚本
  const scriptBlocks = [];
  for (const m of distText.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1])) { scriptBlocks.push({ src: true, attrs: m[1], line: lineOf(distText, m.index), code: '' }); continue; }
    scriptBlocks.push({ src: false, attrs: m[1], line: lineOf(distText, m.index), code: m[2] });
  }
  const inlineSrc = scriptBlocks.filter((s) => s.src);
  checks.push({
    id: 'D5', title: '无 <script src=>（脚本必须内联）', status: inlineSrc.length === 0 ? 'PASS' : 'FAIL',
    detail: inlineSrc.length === 0 ? `共 ${scriptBlocks.length} 个 <script> 块，全部内联` : inlineSrc.map((s) => `L${s.line} ${s.attrs.trim()}`).join('; '),
    evidence: '',
  });

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const syntaxResults = [];
  const escapeRisks = [];
  scriptBlocks.filter((s) => !s.src && s.code.trim()).forEach((s, i) => {
    const isModule = /type\s*=\s*["']module["']/i.test(s.attrs) || /^\s*(import|export)\b/m.test(s.code);
    const ext = isModule ? '.mjs' : '.js';
    const file = path.join(TMP_DIR, `inline-${i + 1}${ext}`);
    fs.writeFileSync(file, s.code, 'utf8');
    // 真 node --check（stdio:'ignore' 才能在本沙箱下拿到退出码）
    const r = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' });
    let vmErr = null;
    if (r.error) {
      try { new vm.Script(s.code, { filename: file }); } catch (e) { vmErr = e; }
    }
    syntaxResults.push({ file, line: s.line, status: r.status, spawnErr: r.error ? r.error.code : null, vmErr: vmErr ? vmErr.message : null, isModule });

    // 若内联脚本里先出现 `<!--` 再出现字面量 `<script`，解析器进入 double-escaped 状态，
    // 之后的 `</script>` 无法正常闭合脚本 → 页面结构被破坏。
    const low = s.code.toLowerCase();
    let j = low.indexOf('<script');
    while (j !== -1) {
      if (low.lastIndexOf('<!--', j) !== -1) {
        const codeLine = (s.code.slice(0, j).match(/\n/g) || []).length + 1;
        escapeRisks.push(`内联脚本内 \`<!--\` 之后出现字面量 \`<script\`（脚本文件内 L${codeLine} / HTML≈L${s.line + codeLine - 1}）→ 触发 double-escaped 解析状态`);
      }
      j = low.indexOf('<script', j + 1);
    }
  });
  // 标签计数不平衡 = 内联 JS 里混进了字面量 <script>/</script，属脆弱写法（今天可能不爆，改动后会爆）
  const rawOpens = countMatches(distText, /<script[\s>]/gi);
  const rawCloses = countMatches(distText, /<\/script/gi);
  const blockStartLines = new Set(scriptBlocks.map((s) => s.line));
  const literalOpens = rawOpens.filter((m) => !blockStartLines.has(m.line));
  const imbalance = rawOpens.length !== rawCloses.length;
  if (imbalance && !escapeRisks.length) {
    escapeRisks.push(`字面量计数不平衡: <script 开标签 ${rawOpens.length} 个 vs </script 闭标签 ${rawCloses.length} 个` +
      (literalOpens.length ? `，内联 JS 内的字面量位于 HTML 行 ${literalOpens.map((m) => m.line).join(',')}（当前其前无 <!--，不破坏解析，但属脆弱写法：一旦前面出现 <!-- 或出现 </script 就会截断/破坏页面）` : ''));
  }
  const d7Risky = escapeRisks.some((e) => e.includes('double-escaped'));
  checks.push({
    id: 'D7', title: '内联脚本无「字面量 script 标签」解析陷阱',
    status: escapeRisks.length === 0 ? 'PASS' : (d7Risky ? 'FAIL' : 'WARN'),
    detail: escapeRisks.length === 0 ? '标签计数平衡，且内联脚本中无 <!--+<script 组合'
      : escapeRisks.join(' | '),
    evidence: `raw <script=${rawOpens.length} </script=${rawCloses.length}`,
  });

  const synBad = syntaxResults.filter((s) => (s.spawnErr ? !!s.vmErr : s.status !== 0));
  checks.push({
    id: 'D6', title: '内联脚本语法可解析（node --check）',
    status: synBad.length === 0 ? 'PASS' : 'FAIL',
    detail: syntaxResults.length === 0 ? '无可检查的内联脚本' :
      synBad.length === 0
        ? syntaxResults.map((s) => `${path.basename(s.file)}(L${s.line}) exit=${s.spawnErr ? 'EPERM→vm回退:' + (s.vmErr ? 'ERR' : 'OK') : s.status}`).join('; ')
        : synBad.map((s) => `${path.basename(s.file)}(L${s.line}) exit=${s.status} ${s.vmErr || ''}`).join('; '),
    evidence: syntaxResults.map((s) => `node --check ${path.relative(PROJECT, s.file)} → ${s.spawnErr ? 'spawn ' + s.spawnErr : 'exit ' + s.status}`).join(' | '),
  });

  /* D8 产物 ↔ 当前源 一致性（防「产物是旧模板/旧 CSS 构建的」） */
  if (opts.sourceCheck) {
    const shellPath = path.join(PROJECT, 'index.html');
    const cssPath = path.join(PROJECT, 'css', 'style.css');
    let shell = opts.sourceShell, css = opts.sourceCss, fromDisk = false;
    if (shell === undefined && fs.existsSync(shellPath)) { shell = fs.readFileSync(shellPath, 'utf8'); fromDisk = true; }
    if (css === undefined && fs.existsSync(cssPath)) css = fs.readFileSync(cssPath, 'utf8');
    if (shell === undefined || css === undefined) {
      checks.push({ id: 'D8', title: '产物与当前源一致（模板/CSS 未漂移）', status: 'SKIP', detail: '读不到 index.html 或 css/style.css，无法比对', evidence: '' });
    } else {
      // 把产物里的内联块还原成占位符，骨架应与模板逐字相同
      const skeleton = distText
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/, '<!--@STYLE@-->')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/, '<!--@BUNDLE@-->');
      const skeletonOk = skeleton.trim() === shell.trim();
      const styleM = /<style\b[^>]*>([\s\S]*?)<\/style>/.exec(distText);
      const inlineCss = styleM ? styleM[1] : null;
      const cssOk = inlineCss !== null && inlineCss.trim() === css.trim();
      // mtime 陈旧信号（只在从磁盘读取时才有意义）
      let staleMsg = '';
      if (fromDisk) {
        const dPath = opts.distPath;
        const srcs = [shellPath, cssPath, path.join(PROJECT, 'js', 'physics.js'), path.join(PROJECT, 'js', 'levels.js'), path.join(PROJECT, 'js', 'levels7-12.js'), path.join(PROJECT, 'js', 'game.js')].filter((p) => fs.existsSync(p));
        if (dPath && fs.existsSync(dPath)) {
          const dT = fs.statSync(dPath).mtimeMs;
          const newer = srcs.filter((p) => fs.statSync(p).mtimeMs > dT);
          if (newer.length) staleMsg = `；产物 mtime 早于这些源文件: ${newer.map((p) => path.relative(PROJECT, p)).join(', ')}`;
        }
      }
      const diffs = [];
      if (!skeletonOk) {
        const a = skeleton.trim().split(/\r?\n/), b = shell.trim().split(/\r?\n/);
        let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
        diffs.push(`骨架不一致，首个差异在第 ${i + 1} 行: 产物="${(a[i] || '(缺行)').slice(0, 70)}" vs 模板="${(b[i] || '(缺行)').slice(0, 70)}"`);
      }
      if (!cssOk) diffs.push(`内联 CSS 与 css/style.css 不一致（内联 ${inlineCss === null ? '缺失' : bytes(inlineCss) + 'B'} vs 源 ${bytes(css)}B）`);
      const status = diffs.length ? 'FAIL' : (staleMsg ? 'WARN' : 'PASS');
      checks.push({
        id: 'D8', title: '产物与当前源一致（模板/CSS 未漂移）', status,
        detail: diffs.length ? diffs.join(' | ') + staleMsg
          : `骨架与 index.html 逐字一致；内联 CSS 与 css/style.css 逐字一致${staleMsg || '；产物 mtime 不早于任何源文件'}`,
        evidence: `skeleton sha256=${sha256(skeleton.trim()).slice(0, 12)}… vs template sha256=${sha256(shell.trim()).slice(0, 12)}…`,
      });
    }
  }
  return { checks, syntaxResults };
}

/* ------------------------------------------- 内联前 JS 源码安全检查（预构建） */

function checkJsSources(jsTexts) {
  const res = [];
  const add = (id, title, status, detail, evidence) => res.push({ id, title, status, detail, evidence: evidence || '' });
  if (!jsTexts.length) { add('8.1', 'JS 源码内联安全性（字面量 script 标签）', R.SKIP, '未找到 JS 源文件'); return res; }
  const hardBreaks = [];
  const doubleEsc = [];
  const fragile = [];
  for (const j of jsTexts) {
    const lines = j.text.split(/\r?\n/);
    lines.forEach((ln, i) => {
      const low = ln.toLowerCase();
      if (low.includes('</script')) hardBreaks.push(`${j.name}:${i + 1} 字面量 \`</script\` → 内联后会截断脚本`);
      let j2 = low.indexOf('<script');
      while (j2 !== -1) {
        const before = lines.slice(0, i).join('\n').toLowerCase() + low.slice(0, j2);
        if (before.includes('<!--')) doubleEsc.push(`${j.name}:${i + 1} 字面量 \`<script\` 且此前出现过 \`<!--\` → 内联后进入 double-escaped 状态`);
        else fragile.push(`${j.name}:${i + 1}`);
        j2 = low.indexOf('<script', j2 + 1);
      }
    });
  }
  const status = (hardBreaks.length || doubleEsc.length) ? R.FAIL : (fragile.length ? R.WARN : R.PASS);
  const parts = [];
  if (hardBreaks.length) parts.push(...hardBreaks);
  if (doubleEsc.length) parts.push(...doubleEsc);
  if (fragile.length) parts.push(`脆弱写法（当前其前无 <!--，不破坏解析，但建议改写注释避免字面量）: ${fragile.join(', ')}`);
  add('8.1', 'JS 源码内联安全性（字面量 script 标签）', status,
    parts.length ? parts.join(' | ') : `扫描 ${jsTexts.length} 个 JS 文件，无字面量 <script / </script>`,
    jsTexts.map((j) => j.name).join(', '));
  return res;
}

/* --------------------------- 跨文件拼接安全性（单个 <script> 内联的前提） */

const DEV_JS = /\.(diag|test|dev|spec)\.js$/i;
function checkInlineIntegration(jsTexts) {
  const res = [];
  const add = (id, title, status, detail, evidence) => res.push({ id, title, status, detail, evidence: evidence || '' });
  if (!jsTexts.length) { add('8.2', '跨文件顶层声明冲突 / 拼接后可解析', R.SKIP, '未找到 JS 源文件'); return res; }
  // 顶层声明（列 0 起）在拼接成同一个 <script> 时会互相冲突
  const declRe = /^(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/;
  const decls = new Map();
  for (const j of jsTexts) {
    const base = path.basename(j.name);
    j.text.split(/\r?\n/).forEach((ln, i) => {
      const m = declRe.exec(ln);
      if (!m) return;
      if (!decls.has(m[1])) decls.set(m[1], []);
      decls.get(m[1]).push(`${base}:${i + 1}`);
    });
  }
  const collisions = [...decls.entries()].map(([name, where]) => ({ name, where, files: [...new Set(where.map((w) => w.split(':')[0]))] }))
    .filter((c) => c.files.length > 1);

  // 真拼接「可发布集合」（排除 *.diag.js/*.test.js 等 dev 命名）再 node --check
  const ship = jsTexts.filter((j) => !DEV_JS.test(path.basename(j.name)));
  const skipped = jsTexts.filter((j) => DEV_JS.test(path.basename(j.name))).map((j) => path.basename(j.name));
  const shipFiles = new Set(ship.map((j) => path.basename(j.name)));
  const collisionsAmongShip = collisions.filter((c) => c.files.filter((f) => shipFiles.has(f)).length > 1);
  const devInvolved = collisions.filter((c) => c.files.some((f) => DEV_JS.test(f)));
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const concatFile = path.join(TMP_DIR, 'concat-ship.js');
  fs.writeFileSync(concatFile, ship.map((j) => `\n/* ===== ${path.basename(j.name)} ===== */\n${j.text}`).join('\n'), 'utf8');
  const r = spawnSync(process.execPath, ['--check', concatFile], { stdio: 'ignore' });
  let concatErr = null;
  let concatOk;
  if (r.error) {
    concatOk = null;
    try { new vm.Script(fs.readFileSync(concatFile, 'utf8'), { filename: concatFile }); } catch (e) { concatErr = e.message; }
  } else {
    concatOk = r.status === 0;
    if (!concatOk) { try { new vm.Script(fs.readFileSync(concatFile, 'utf8'), { filename: concatFile }); } catch (e) { concatErr = e.message; } }
  }
  // 权威判据是「可发布集合拼接后能否解析」；dev 文件只要不被打包就不构成问题
  const status = (concatOk === false) ? R.FAIL : ((collisionsAmongShip.length || devInvolved.length) ? R.WARN : R.PASS);
  const parts = [];
  parts.push(`可发布拼接 [${ship.map((j) => path.basename(j.name)).join(', ') || '空'}] node --check → ${concatOk === null ? 'spawn ' + (r.error && r.error.code) + '（vm 回退: ' + (concatErr || 'OK') + '）' : (concatOk ? 'exit 0（可解析）' : 'exit ' + r.status)}`);
  if (concatErr && concatOk !== true) parts.push(`解析错误: ${concatErr.split('\n').slice(0, 3).join(' / ')}`);
  if (skipped.length) parts.push(`已排除 dev 命名文件: ${skipped.join(', ')}；它们不得被打包`);
  if (collisionsAmongShip.length) parts.push('可发布文件之间的重复顶层声明: ' + collisionsAmongShip.map((c) => `${c.name} @ ${c.where.join(', ')}`).join(' | '));
  if (devInvolved.length) parts.push(`dev 文件与可发布文件冲突 ${devInvolved.length} 处（只要 build 不打包 dev 文件即可；若打包 → SyntaxError，游戏整个内联脚本失效）: ` + devInvolved.map((c) => `${c.name} @ ${c.where.join(', ')}`).join(' | '));
  add('8.2', '跨文件顶层声明冲突 / 拼接后可解析（单 <script> 前提）', status, parts.join(' | '),
    `扫描 ${jsTexts.length} 个 JS：${jsTexts.map((j) => path.basename(j.name)).join(', ')}`);
  return res;
}

/* ------------------------------------------------------------------ 主流程 */

function findCssFiles(dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (['node_modules', 'tmp', '.git', 'verify', 'tools', 'dist'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findCssFiles(p, acc);
    else if (/\.css$/i.test(e.name)) acc.push(p);
  }
  return acc;
}
function readCssSources(html, explicit) {
  const out = [];
  if (html) for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push({ name: '<inline style>', text: m[1] });
  for (const f of explicit) { try { out.push({ name: path.relative(PROJECT, f), text: fs.readFileSync(f, 'utf8') }); } catch (e) { out.push({ name: path.relative(PROJECT, f), text: '', error: e.message }); } }
  return out;
}
/** 从 build.mjs 的显式打包清单里读出「真正会被内联的文件」；读不到就回退到 js/ 目录 */
function shippedJsFiles(root) {
  const bp = path.join(root, 'build.mjs');
  if (!fs.existsSync(bp)) return [];
  const t = fs.readFileSync(bp, 'utf8');
  const out = [];
  for (const m of t.matchAll(/file\s*:\s*['"]([^'"]+\.(?:js|mjs))['"]/g)) out.push(m[1].replace(/\\/g, '/'));
  return [...new Set(out)];
}
function readJsSources(root = PROJECT) {
  const declared = shippedJsFiles(root);
  if (declared.length) {
    return declared.filter((f) => fs.existsSync(path.join(root, f)))
      .map((f) => ({ name: f.replace(/\//g, path.sep), text: fs.readFileSync(path.join(root, f), 'utf8'), declared: true }));
  }
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['node_modules', 'dist', 'tmp', '.git', 'verify', 'tools'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/i.test(e.name)) out.push({ name: path.relative(root, p), text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(path.join(root, 'js'));
  return out;
}
function printResults(title, results) {
  console.log(`\n=== ${title} ===`);
  const w = Math.max(...results.map((r) => (r.id + ' ' + r.title).length), 10);
  for (const r of results) {
    const pad = (r.id + ' ' + r.title).padEnd(w);
    console.log(`[${r.status}] ${pad} | ${r.detail}`);
    if (r.evidence) console.log(`         evidence: ${r.evidence.slice(0, 400)}`);
  }
  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(`--- 小计: PASS=${n('PASS')} FAIL=${n('FAIL')} WARN=${n('WARN')} SKIP=${n('SKIP')}`);
}
function writeReport(mode, results, extra) {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const payload = { tool: 'gravity-flip/tools/verify_ui.mjs', mode, timestamp: new Date().toISOString(), cwd: process.cwd(), results, extra: extra || {} };
  fs.writeFileSync(path.join(VERIFY_DIR, `report-${mode}.json`), JSON.stringify(payload, null, 2), 'utf8');
  const md = [`# verify_ui 报告 — ${mode}`, '', `时间: ${payload.timestamp}`, '',
    '| id | 检查项 | 结果 | 详情 |', '| --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.id} | ${r.title} | **${r.status}** | ${String(r.detail).replace(/\|/g, '\\|')} |`), '',
    `小计: PASS=${results.filter((r) => r.status === 'PASS').length} FAIL=${results.filter((r) => r.status === 'FAIL').length} WARN=${results.filter((r) => r.status === 'WARN').length} SKIP=${results.filter((r) => r.status === 'SKIP').length}`, ''].join('\n');
  fs.writeFileSync(path.join(VERIFY_DIR, `report-${mode}.md`), md, 'utf8');
  return path.join(VERIFY_DIR, `report-${mode}.md`);
}

/* --------------------------------------------------------------- self-test */

function selfTest() {
  const goodHtml = `<!doctype html><html><head>
<!--@STYLE@-->
</head><body>
<div id="wrap"><canvas id="game" width="1280" height="720"></canvas>
<div id="hud"><span id="level"></span><span id="hint">x</span><span id="time"></span><span id="flips"></span><span id="stars"></span></div>
<div id="overlay" hidden><h2 id="overlay-title"></h2><p id="overlay-body"></p><div id="overlay-buttons"></div></div>
<button type="button" data-action="left">L</button><button type="button" data-action="right">R</button>
<button type="button" data-action="jump">J</button><button type="button" data-action="flip">F</button></div>
<!--@BUNDLE@-->
</body></html>`;
  const goodCss = `#game{aspect-ratio:16/9;width:100%;max-width:1280px;max-height:720px}button[data-action]{touch-action:none}#overlay{display:flex}#overlay[hidden]{display:none}`;
  const goodReadme = '# Gravity Flip\n\n| 按键 | 动作 |\n| --- | --- |\n| `←` / `A` | 向左移动 |\n| `→` / `D` | 向右移动 |\n| `Space` | 跳跃 |\n| `Shift` | 重力翻转 |\n';
  const goodJs = `addEventListener('keydown',e=>{if(e.key==='ArrowLeft'){}if(e.key==='a'){}if(e.key==='ArrowRight'){}if(e.key==='d'){}if(e.key===' '){}if(e.key==='Shift'){}});`;
  const goodHint = '←/→ 或 A/D 移动 · Space 跳 · Shift 翻转';

  const g = [
    ...checkTemplate(goodHtml, [{ name: 'fixture.css', text: goodCss }], { template: true }),
    ...checkReadme(goodReadme, [{ name: 'fixture.js', text: goodJs }], goodHint),
  ];
  const gFail = g.filter((r) => r.status === 'FAIL');

  const badHtml = goodHtml
    .replace('<!--@STYLE@-->', '<!--@STYLE@-->\n<!--@STYLE@-->')
    .replace('<div id="hud">', '<div id="hudX">')
    .replace('<button type="button" data-action="jump">J</button>', '<button data-action="jump">J</button>')
    .replace('<div id="overlay" hidden>', '<div id="overlay">')
    .replace('<span id="hint">x</span>', '<span id="hint">A 跳 · D 右移</span>');
  const badCss = '#game{}\n#overlay{display:flex}';
  const badReadme = '| 按键 | 动作 |\n| --- | --- |\n| `A` | 向左移动 |\n| `A` | 向右移动 |\n| `D` | 向右移动 |\n';
  const badHint = 'A 跳 · D 右移';
  const b = [
    ...checkTemplate(badHtml, [{ name: 'fixture.css', text: badCss }], { template: true }),
    ...checkReadme(badReadme, [{ name: 'fixture.js', text: goodJs }], badHint),
  ];
  const bFailedIds = b.filter((r) => r.status === 'FAIL').map((r) => r.id);

  const distGood = `<!doctype html><html><head><style>#game{aspect-ratio:16/9}</style></head><body><canvas id="game" width="1280" height="720"></canvas><script>var x=1;</script></body></html>`;
  const dg = checkDist(distGood, [{ name: 'inline', text: '#game{aspect-ratio:16/9}' }]).checks;
  const distBad = `<!doctype html><html><head><link rel="stylesheet" href="style.css"><style>body{background:url(bg.png)}</style></head><body><canvas id="game" width="1280" height="720"></canvas><a href="https://example.com">x</a><!--@BUNDLE@--><script>/* <!-- */ var t="<script>"; var x=;</script></body></html>`;
  const db = checkDist(distBad, [{ name: 'inline', text: 'body{background:url(bg.png)}' }]).checks;
  const dbFailedIds = db.filter((c) => c.status === 'FAIL').map((c) => c.id);

  const jsGood = checkJsSources([{ name: 'good.js', text: 'var a = 1; // <script> harmless here\n' }]);
  const jsHard = checkJsSources([{ name: 'hard.js', text: 'var s = "</script>";' }]);
  const jsDouble = checkJsSources([{ name: 'dbl.js', text: '/* <!-- */\nvar t = "<script>";' }]);
  const jsOk = !jsGood.some((r) => r.status === 'FAIL') && jsGood.some((r) => r.status === 'WARN');
  const jsCatch = jsHard.some((r) => r.status === 'FAIL') && jsDouble.some((r) => r.status === 'FAIL');

  // D8：产物与源一致性（注入式夹具，不读真实项目文件）
  const shellFx = '<!doctype html><html><head>\n<!--@STYLE@-->\n</head><body><div id="a"></div>\n<!--@BUNDLE@-->\n</body></html>';
  const cssFx = '#game{aspect-ratio:16/9}';
  const distFx = shellFx.replace('<!--@STYLE@-->', '<style>\n' + cssFx + '\n</style>').replace('<!--@BUNDLE@-->', '<script>\nvar x=1;\n</script>');
  const d8pick = (t, c) => checkDist(t, [{ name: 'inline', text: c }], { sourceCheck: true, sourceShell: shellFx, sourceCss: cssFx }).checks.find((x) => x.id === 'D8');
  const d8Same = d8pick(distFx, cssFx);
  const d8CssDrift = d8pick(distFx.replace('#game{aspect-ratio:16/9}', '#game{aspect-ratio:4/3}'), '#game{aspect-ratio:4/3}');
  const d8SkelDrift = d8pick(distFx.replace('id="a"', 'id="b"'), cssFx);
  const d8Ok = d8Same && d8Same.status === 'PASS' && d8CssDrift && d8CssDrift.status === 'FAIL' && d8SkelDrift && d8SkelDrift.status === 'FAIL';

  const jsClean = checkInlineIntegration([{ name: 'js/a.js', text: 'const A = 1;\n' }, { name: 'js/b.js', text: 'const B = 2;\n' }]);
  const jsDevShape = checkInlineIntegration([{ name: 'js/a.js', text: 'const X = 1;\n' }, { name: 'js/a.diag.js', text: 'const X = 1;\n' }]);
  const jsCollide = checkInlineIntegration([{ name: 'js/a.js', text: 'const COLS = 32;\n' }, { name: 'js/b.js', text: 'const COLS = 32;\n' }]);
  const injOk = jsClean.some((r) => r.status === 'PASS') && jsDevShape.some((r) => r.status === 'WARN') && jsCollide.some((r) => r.status === 'FAIL');

  const expectedGoodOk = gFail.length === 0;
  const expectedBadCatch = ['1.1', '2.1', '2.3', '3.1', '5.1', '5.2', '7.1', '7.4'].every((id) => bFailedIds.includes(id));
  const distGoodOk = dg.every((c) => c.status === 'PASS');
  const distBadCatch = ['D1', 'D2', 'D3', 'D4', 'D6', 'D7'].every((id) => dbFailedIds.includes(id));

  console.log('=== SELF-TEST: 检查器必须能区分「正确输入」与「注入缺陷的输入」 ===');
  console.log(`1) 合格夹具应 0 FAIL           : ${expectedGoodOk ? 'PASS' : 'FAIL'} (实际 FAIL: ${gFail.map((r) => r.id + ':' + r.detail).join(' | ') || '无'})`);
  console.log(`2) 缺陷夹具应报出 1.1/2.1/2.3/3.1/5.1/5.2/7.1/7.4: ${expectedBadCatch ? 'PASS' : 'FAIL'} (实际 FAIL: ${bFailedIds.join(',')})`);
  console.log(`3) 合格产物应全 PASS           : ${distGoodOk ? 'PASS' : 'FAIL'} (${dg.filter((c) => c.status !== 'PASS').map((c) => c.id + ':' + c.detail).join(' | ') || '无'})`);
  console.log(`4) 缺陷产物应报出 D1/D2/D3/D4/D6/D7: ${distBadCatch ? 'PASS' : 'FAIL'} (实际 FAIL: ${dbFailedIds.join(',')})`);
  console.log(`5) JS 字面量 <script> 应 WARN、</script> 与 <!--+<script 应 FAIL: ${jsOk && jsCatch ? 'PASS' : 'FAIL'} (good=${jsGood.map((r) => r.status).join(',')} hard=${jsHard.map((r) => r.status).join(',')} double=${jsDouble.map((r) => r.status).join(',')})`);
  console.log(`6) 跨文件拼接: 干净应 PASS、dev 冲突应 WARN、真冲突应 FAIL: ${injOk ? 'PASS' : 'FAIL'} (clean=${jsClean.map((r) => r.status).join(',')} dev=${jsDevShape.map((r) => r.status).join(',')} collide=${jsCollide.map((r) => r.status).join(',')})`);
  console.log(`7) D8 产物↔源: 一致应 PASS、CSS 漂移/骨架漂移应 FAIL: ${d8Ok ? 'PASS' : 'FAIL'} (same=${d8Same && d8Same.status} cssDrift=${d8CssDrift && d8CssDrift.status} skelDrift=${d8SkelDrift && d8SkelDrift.status})`);
  const allOk = expectedGoodOk && expectedBadCatch && distGoodOk && distBadCatch && jsOk && jsCatch && injOk && d8Ok;
  console.log(`=== SELF-TEST ${allOk ? 'PASS' : 'FAIL'} ===`);
  return allOk ? 0 : 1;
}

/* -------------------------------------------------------------------- main */

function main() {
  const argv = process.argv.slice(2);
  let dist = null;
  let root = PROJECT;
  const explicitStyle = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--self-test') return selfTest();
    else if (a === '--dist') dist = path.resolve(PROJECT, argv[++i]);
    else if (a.startsWith('--dist=')) dist = path.resolve(PROJECT, a.slice(7));
    else if (a === '--root') root = path.resolve(PROJECT, argv[++i]);
    else if (a.startsWith('--root=')) root = path.resolve(PROJECT, a.slice(7));
    else if (a === '--style') explicitStyle.push(path.resolve(PROJECT, argv[++i]));
    else if (a.startsWith('--style=')) explicitStyle.push(path.resolve(PROJECT, a.slice(8)));
    else if (a === '--help') { console.log('用法见文件头注释'); return 0; }
    else { console.log(`未知参数: ${a}`); return 2; }
  }

  if (dist) {
    if (!fs.existsSync(dist)) {
      console.log(`[TARGET MISSING] 产物不存在: ${path.relative(PROJECT, dist)}`);
      return 2;
    }
    const distText = fs.readFileSync(dist, 'utf8');
    const styles = readCssSources(distText, explicitStyle);
    const structural = checkTemplate(distText, styles, { template: false });
    const { checks, syntaxResults } = checkDist(distText, styles, { sourceCheck: true, distPath: dist });
    const all = [...checks, ...structural];
    printResults(`产物自包含检查: ${path.relative(PROJECT, dist)}`, all);
    console.log(`样式源: ${styles.map((s) => `${s.name}(${bytes(s.text)}B)`).join(', ') || '无'}`);
    console.log(`产物 sha256=${sha256(distText).slice(0, 16)}… (${bytes(distText)}B)`);
    const isFinal = path.basename(dist) === 'gravity-flip.html';
    console.log(`报告: ${path.relative(PROJECT, writeReport(isFinal ? 'dist' : 'dist-simulated', all, { dist: path.relative(PROJECT, dist), syntaxResults }))}`);
    return all.some((r) => r.status === 'FAIL') ? 1 : 0;
  }

  const htmlPath = path.join(root, 'index.html');
  const readmePath = path.join(root, 'README.md');
  const missingTargets = [];
  if (!fs.existsSync(htmlPath)) missingTargets.push('index.html');
  if (!fs.existsSync(readmePath)) missingTargets.push('README.md');
  if (missingTargets.length) {
    console.log(`[TARGET MISSING] 待验证文件不存在: ${missingTargets.join(', ')}（根目录 ${root}）`);
    return 2;
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const cssFiles = findCssFiles(root);
  const styles = readCssSources(html, [...cssFiles, ...explicitStyle]);
  const jsTexts = readJsSources(root);
  const hintText = innerTextOf(html, 'hint');
  const results = [...checkTemplate(html, styles, { template: true }), ...checkReadme(readme, jsTexts, hintText), ...checkJsSources(jsTexts), ...checkInlineIntegration(jsTexts)];
  const mode = root === PROJECT ? 'shell' : 'shell-fixture';
  printResults(`外壳检查: ${path.relative(root, htmlPath) || 'index.html'} + README.md`, results);
  const hashes = { 'index.html': sha256(html), 'README.md': sha256(readme), ...Object.fromEntries(styles.map((s) => [s.name, s.text ? sha256(s.text) : '(未读到)'])) };
  console.log(`HTML: ${path.relative(root, htmlPath)} (${bytes(html)}B) sha256=${hashes['index.html'].slice(0, 16)}…`);
  console.log(`CSS 源: ${styles.map((s) => `${s.name}(${bytes(s.text)}B)`).join(', ') || '无 << 注意：无 CSS 源时 3.2/4.2 必然 FAIL'}`);
  console.log(`JS 源: ${jsTexts.map((j) => j.name).join(', ') || '无'}`);
  console.log(`#hint: ${hintText ? `"${hintText.slice(0, 70)}"` : '(未找到)'}`);
  console.log(`已校验修订哈希: ${Object.entries(hashes).map(([k, v]) => `${k}=${v.slice(0, 16)}…`).join(' ')}`);
  console.log(`报告: ${path.relative(PROJECT, writeReport(mode, results, { root: path.relative(PROJECT, root) || '.', html: path.relative(root, htmlPath), cssSources: styles.map((s) => s.name), jsSources: jsTexts.map((j) => j.name), hint: hintText, hashes }))}`);
  return results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

process.exit(main());
