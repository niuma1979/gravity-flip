'use strict';
/* =========================================================================
 * 构建：把外壳 + CSS + 运行时代码打成一个可双击运行的单文件 HTML。
 *
 * 用法: node build.mjs
 * 产物: dist/gravity-flip.html
 *
 * 注意（verifier 在预构建阶段实测出的高危点）：
 *   1) 打包文件必须用「显式清单」，绝对不能用 js/*.js 通配 —— 目录里一旦出现
 *      任何带同名顶层声明的临时/诊断文件，内联脚本就会 SyntaxError 白屏。
 *   2) 内联脚本里任何字面量 "</script" 都会让 HTML 解析器提前结束脚本，
 *      所以这里统一做转义，并且构建后复检。
 * ========================================================================= */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const SHELL = 'index.html';
const CSS = 'css/style.css';

/** 显式打包清单：顺序固定，依赖在前，运行时代码最后 */
const SHIP = [
  { file: 'js/physics.js', global: 'window.GF_PHYSICS' },
  { file: 'js/levels.js', global: 'window.GF_LEVELS_1_6' },
  { file: 'js/levels7-12.js', global: 'window.GF_LEVELS_7_12' },
  { file: 'js/game.js', global: '(IIFE, 直接启动)' }
];

function check(cond, msg) {
  if (!cond) { console.error('BUILD FAIL: ' + msg); process.exit(1); }
}

/* ------------------------------ 1. 读入 ------------------------------ */
const shell = read(SHELL);
const css = read(CSS);

const parts = [];
for (const s of SHIP) {
  check(fs.existsSync(path.join(root, s.file)), '缺少打包文件 ' + s.file);
  const code = read(s.file);
  check(code.trim().length > 0, s.file + ' 为空');
  parts.push('/* ===== ' + s.file + ' (' + s.global + ') ===== */\n' + code);
}

/* --------------------------- 2. 拼接与加固 --------------------------- */
let js = parts.join('\n;\n');
// 任何字面量 "</script" 都会截断内联脚本
const scriptTagHits = (js.match(/<\/script/gi) || []).length;
js = js.replace(/<\/script/gi, '<\\/script');

/* ------------------------------ 3. 内联 ------------------------------ */
check(shell.includes('<!--@STYLE@-->'), '模板缺少 <!--@STYLE@--> 占位符');
check(shell.includes('<!--@BUNDLE@-->'), '模板缺少 <!--@BUNDLE@--> 占位符');

let out = shell.replace('<!--@STYLE@-->', '<style>\n' + css + '\n</style>');
out = out.replace('<!--@BUNDLE@-->', '<script>\n' + js + '\n</script>');
check(out !== shell, '占位符替换没有生效');

/* ------------------------------ 4. 复检 ------------------------------ */
check(!out.includes('@STYLE@'), '产物仍残留 @STYLE@');
check(!out.includes('@BUNDLE@'), '产物仍残留 @BUNDLE@');

// 外部请求检查
const externals = [];
for (const re of [/\ssrc\s*=\s*["'][^"']+["']/gi, /\shref\s*=\s*["'][^"']+["']/gi, /@import/gi, /url\(\s*["']?https?:/gi]) {
  const found = out.match(re);
  if (found) externals.push(...found.slice(0, 3));
}
check(externals.length === 0, '产物含外部引用: ' + externals.join(', '));

// 只允许出现一个 <style> 和一个 <script>
check((out.match(/<style/gi) || []).length === 1, '产物 <style> 数量不为 1');
check((out.match(/<script/gi) || []).length === 1, '产物 <script> 数量不为 1');

// 把内联脚本抽出来做真正的语法检查。
// 注意：本沙箱禁止 Node 用管道捕获子进程输出（EPERM），所以
//   主力手段是进程内 new Function 编译（能拿到带行号的 SyntaxError），
//   再用 stdio:'ignore' 的 node --check 拿退出码做独立二次确认。
const m = out.match(/<script>\n([\s\S]*?)\n<\/script>/);
check(m, '无法从产物中抽出内联脚本');
const body = m[1];

try {
  // eslint-disable-next-line no-new-func
  new Function(body);
} catch (e) {
  console.error('BUILD FAIL: 内联脚本语法错误 -> ' + e.message);
  process.exit(1);
}

const tmpDir = path.join(root, '.build-tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const tmpJs = path.join(tmpDir, 'bundle-check.js');
fs.writeFileSync(tmpJs, body, 'utf8');
const res = spawnSync(process.execPath, ['--check', tmpJs], { stdio: 'ignore' });
fs.rmSync(tmpDir, { recursive: true, force: true });
check(res.status === 0, 'node --check 未通过（退出码 ' + res.status + '）');

/* ------------------------------ 5. 写出 ------------------------------ */
const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'gravity-flip.html');
fs.writeFileSync(outPath, out, 'utf8');
fs.rmSync(tmpDir, { recursive: true, force: true });

const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
console.log('构建成功: ' + path.relative(root, outPath));
console.log('  体积: ' + kb + ' KB');
console.log('  打包文件: ' + SHIP.map((s) => s.file).join(' + '));
console.log('  内联脚本: ' + (m[1].length / 1024).toFixed(1) + ' KB, node --check 通过');
if (scriptTagHits) console.log('  已转义 ' + scriptTagHits + ' 处字面量 </script');
