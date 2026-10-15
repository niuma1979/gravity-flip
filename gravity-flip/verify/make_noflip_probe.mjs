/**
 * gravity-flip/verify/make_noflip_probe.mjs
 *
 * 验证方自用：从 Lead 的 tools/solve_levels.mjs 生成一个「禁止翻转」的探针副本，
 * 用来独立回答「翻转是不是通关必需」——如果某关在禁止翻转时仍能通关，
 * 那么「最少翻转 >= 1」这个闸门就是错的。
 *
 * 只读 tools/ 下的原件；产物写到 verify/（本验证者的写入范围）。
 * 不改动 Lead 的脚本，也不覆盖 reports/solve_report.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const srcPath = path.join(ROOT, 'tools', 'solve_levels.mjs');
const src = fs.readFileSync(srcPath, 'utf8');

const anchor = "MACROS.push({ dir: 0, jump: false, flip: false, n: 20, idle: true });";
if (!src.includes(anchor)) { console.error('FAIL: 找不到 MACROS 锚点，solve_levels.mjs 结构已变'); process.exit(1); }

const injected = anchor +
  "\n// ---- NOFLIP PROBE（验证方注入）：去掉所有带翻转的宏动作 ----\n" +
  "for (let i = MACROS.length - 1; i >= 0; i--) if (MACROS[i].flip) MACROS.splice(i, 1);\n" +
  "console.log('NOFLIP PROBE: 宏动作库已移除全部翻转动作，剩余 ' + MACROS.length + ' 个宏');\n";

let out = src.replace(anchor, injected);
const repBefore = out;
out = out.replace("path.join(root, 'reports', 'solve_report.json')", "path.join(root, 'verify', 'noflip_report.json')");
if (out === repBefore) { console.error('FAIL: 报告路径替换失败（避免覆盖 Lead 的 solve_report.json）'); process.exit(1); }

fs.writeFileSync(path.join(HERE, 'noflip_probe.mjs'), out, 'utf8');
console.log('已生成 verify/noflip_probe.mjs：翻转宏已移除，报告改写到 verify/noflip_report.json');
