/**
 * gravity-flip/verify/make_dist_runtime_test.mjs
 *
 * 验证方自用：生成一个 tools/smoke_test.mjs 的副本，把「加载 js/*.js 四个源文件」
 * 换成「加载 dist/gravity-flip.html 里的那一段内联脚本」。
 *
 * 目的：Lead 的 smoke_test 一直在测「源文件」，而产物是拼接后的单文件 ——
 * 本探针用同一套 DOM 桩和同一批断言去跑真正的打包产物，验证
 * 「打包后的脚本真的能跑」（语法检查抓不到的运行时问题：打包顺序、全局挂载、
 * 拼接处的分号、</script 转义等）。
 *
 * 只读 tools/ 与 dist/；产物写到 verify/（本验证者的写入范围）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const src = fs.readFileSync(path.join(ROOT, 'tools', 'smoke_test.mjs'), 'utf8');

const anchor = `load('js/physics.js');
load('js/levels.js');
load('js/levels7-12.js');
load('js/game.js');`;

if (!src.includes(anchor)) { console.error('FAIL: 找不到四行 load(...) 锚点，smoke_test.mjs 结构已变'); process.exit(1); }

const injected = `/* ---- 验证方注入：加载 dist 产物的内联脚本，而不是 js/ 源文件 ---- */
const fsx = require('node:fs');
const distHtml = fsx.readFileSync(path.join(root, 'dist', 'gravity-flip.html'), 'utf8');
const bm = distHtml.match(/<script>\\n([\\s\\S]*?)\\n<\\/script>/);
if (!bm) { errors.push('无法从 dist 产物中抽出内联脚本'); }
else {
  try { new Function(bm[1])(); } catch (e) { errors.push('加载 dist 内联脚本失败: ' + e.stack); }
}
console.log('== 本次运行加载的是 dist/gravity-flip.html 的内联脚本（' + (bm ? bm[1].length : 0) + ' 字符），不是 js/ 源文件 ==');`;

const out = src.replace(anchor, injected);
fs.writeFileSync(path.join(HERE, 'dist_runtime_test.mjs'), out, 'utf8');
console.log('已生成 verify/dist_runtime_test.mjs：将加载 dist 内联脚本');
