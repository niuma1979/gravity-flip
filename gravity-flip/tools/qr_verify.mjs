'use strict';
/* =========================================================================
 * 二维码端到端验证：Python 生成 → 独立 Node 解码器从 PNG 像素读回原文。
 *
 * 覆盖多个版本（内容长度不同）、多种模块尺寸、以及「带说明文字的分享卡片」。
 * 全部 PASS 才说明二维码真的能被标准扫码器读懂。
 *
 * 用法: node tools/qr_verify.mjs
 * ========================================================================= */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = path.join(root, '.qr-tmp');

// Python 解释器：优先环境变量，其次本机 DSH 运行时，最后回退到 python3/python。
// 这样在 Windows 本地和 GitHub Actions 的 ubuntu runner 上都能跑。
function findPython() {
  const cands = [
    process.env.DSH_PYTHON,
    'C:\\Users\\paqiu\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
    'python3',
    'python'
  ].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ['-c', 'import PIL'], { stdio: 'ignore' });
    if (r.status === 0) return c;
  }
  return null;
}

const PY = findPython();
const NODE = process.execPath;

const cases = [
  { url: 'https://gravity-flip.pages.dev/', scale: 8, label: null },
  { url: 'https://gravity-flip.pages.dev/', scale: 4, label: null },
  { url: 'https://gravity-flip.pages.dev/', scale: 12, label: '扫码即玩：重力反转 GRAVITY FLIP' },
  { url: 'http://192.168.1.170:8080/', scale: 6, label: null },
  { url: 'https://example.com/', scale: 8, label: '短链接' },
  { url: 'https://gravity-flip.pages.dev/?from=qq&utm_source=share&v=2', scale: 8, label: '带参数的长链接' },
  { url: 'https://a-very-long-domain-name.example.org/some/deep/path/to/gravity-flip/index.html', scale: 6, label: null }
];

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

let pass = 0, fail = 0;
if (!PY) {
  console.log('SKIP: 找不到带 Pillow 的 Python（本地请设 DSH_PYTHON，CI 里由 setup-python + pip install pillow 提供）');
  process.exit(2);
}
console.log('== 二维码端到端：Python 生成 → 独立解码器读回 ==');
console.log('   Python: ' + PY);
for (const [i, c] of cases.entries()) {
  const png = path.join(tmp, `qr-${i}.png`);
  const args = [path.join(root, 'tools', 'make_qr.py'), c.url, '-o', png, '--scale', String(c.scale)];
  if (c.label) args.push('--label', c.label);
  const gen = spawnSync(PY, args, { stdio: 'ignore' });
  if (gen.status !== 0) { console.log(`  FAIL  生成失败: ${c.url}`); fail++; continue; }

  const dec = spawnSync(NODE, [path.join(root, 'tools', 'qr_reader.mjs'), png, '--expect', c.url], { stdio: 'ignore' });
  const ok = dec.status === 0;
  if (ok) pass++; else fail++;
  const size = fs.statSync(png).size;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  scale=${String(c.scale).padStart(2)} ${String(size).padStart(6)}B  ${c.label ? '[带文字] ' : '         '}${c.url.slice(0, 58)}`);
}

console.log(`\n二维码验证: ${pass} PASS / ${fail} FAIL`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
