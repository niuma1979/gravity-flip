/**
 * gravity-flip/verify/independent_build_sim.mjs
 *
 * 验证方自用的「构建模拟器」——不是交付物、不是 Lead 的 build.mjs。
 * 目的：在真正的 build.mjs 产出 dist 之前，独立预演 `<!--@STYLE@-->` / `<!--@BUNDLE@-->`
 * 的纯字符串替换，尽早发现模板/自包含问题。产出的 HTML 仅供 tools/verify_ui.mjs --dist 检查。
 *
 * 用法: node verify/independent_build_sim.mjs   （输出 verify/tmp/simulated-build.html）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const jsDir = path.join(ROOT, 'js');
const jsFiles = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort();
const js = jsFiles.map((f) => `\n/* ===== ${f} ===== */\n` + fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');

const out = html
  .replace('<!--@STYLE@-->', `<style>\n${css}\n</style>`)
  .replace('<!--@BUNDLE@-->', `<script>\n${js}\n</script>`);

fs.mkdirSync(path.join(HERE, 'tmp'), { recursive: true });
const outFile = path.join(HERE, 'tmp', 'simulated-build.html');
fs.writeFileSync(outFile, out, 'utf8');
console.log(`模拟构建完成（独立实现，非 build.mjs）`);
console.log(`  模板: index.html (${html.length}B)`);
console.log(`  样式: css/style.css (${css.length}B)`);
console.log(`  脚本: ${jsFiles.join(', ')}`);
console.log(`  产物: ${path.relative(ROOT, outFile)} (${out.length}B)`);
console.log(`  注意: js/game.js（按键绑定与主循环）尚不存在，此产物不完整，仅用于预演自包含性`);
