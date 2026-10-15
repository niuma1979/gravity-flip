'use strict';
/* =========================================================================
 * 独立 QR 解码器（验证 tools/make_qr.py 的输出是否真的符合标准）
 *
 * 为什么要单独写一份：Python 侧的 --self-test 用的是它自己的编码表，
 * 万一表本身错了（比如纠错块结构写错），自检照样通过，但**手机扫码器按标准
 * 表来纠错就会失败**。所以这里用完全独立的实现（另一种语言、从 PNG 像素出发、
 * 自己解析格式信息和码字）把内容读回来。两边都对上，才算真的对。
 *
 * 覆盖：PNG 解码(zlib) → 模块网格 → 定位/定时图案校验 → 格式信息 BCH 校验
 *      → 去掩码 → Z 字形读码字 → 反交织 → Reed-Solomon 重算校验 → 解析文本
 *
 * 用法: node tools/qr_reader.mjs <png> [--expect "原文"]
 * ========================================================================= */

import fs from 'node:fs';
import zlib from 'node:zlib';

/* ----------------------------- PNG 解码 ----------------------------- */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8 位深 PNG，实际 ' + bitDepth);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) throw new Error('未知过滤器 ' + filter);
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}

/**
 * 从 PNG 里切出模块网格。
 *
 * 不再用「找 7:1:3:1:7 的横向游程」这种脆弱启发式（那条路我踩了很多坑：
 * 定位图案顶边与内部行的游程完全不同）。改成更稳的做法：
 *   图片左上角第一个暗像素就是左上定位图案的外角 → 取它作为网格原点，
 *   然后枚举「模块尺寸 m」，用**定位图案 + 定时图案**去验证候选，
 *   第一个通过验证的 m 就是正确答案；最后按模块取块平均来判定明暗。
 * 这样即使图上有说明文字（在二维码下方/上方）也不受影响。
 */
function extractModules(png) {
  const { width, height, channels, pixels } = png;
  const lumAt = (x, y) => {
    const i = (y * width + x) * channels;
    return (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
  };
  const dark = (x, y) => (x >= 0 && y >= 0 && x < width && y < height) && lumAt(x, y) < 128;

  // 左上角第一个暗像素
  let ox = -1, oy = -1;
  outer:
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (dark(x, y)) { ox = x; oy = y; break outer; }
    }
  }
  if (ox < 0) throw new Error('图上找不到暗像素');

  const inBounds = (m, size) => ox + m * size <= width && oy + m * size <= height;
  // 按模块取块平均（比取中心点更抗锯齿）
  const sample = (m, size) => {
    const g = [];
    for (let r = 0; r < size; r++) {
      const row = [];
      for (let c = 0; c < size; c++) {
        let tot = 0, cnt = 0;
        for (let dy = 0; dy < m; dy++) {
          for (let dx = 0; dx < m; dx++) {
            tot += lumAt(ox + c * m + dx, oy + r * m + dy);
            cnt++;
          }
        }
        row.push(tot / cnt < 128 ? 1 : 0);
      }
      g.push(row);
    }
    return g;
  };

  const finderOK = (g, r0, c0) => {
    const want = [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1,
      1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 1,
      1, 1, 1, 1, 1, 1, 1];
    let k = 0;
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) if (g[r0 + r][c0 + c] !== want[k++]) return false;
    return true;
  };
  const timingOK = (g, size) => {
    for (let i = 8; i < size - 8; i++) {
      if (g[6][i] !== (i % 2 === 0 ? 1 : 0)) return false;
      if (g[i][6] !== (i % 2 === 0 ? 1 : 0)) return false;
    }
    return true;
  };

  for (let m = 2; m <= 40; m++) {
    for (let v = 1; v <= 10; v++) {
      const size = v * 4 + 17;
      if (!inBounds(m, size)) continue;
      const g = sample(m, size);
      if (!finderOK(g, 0, 0) || !finderOK(g, 0, size - 7) || !finderOK(g, size - 7, 0)) continue;
      if (!timingOK(g, size)) continue;
      return { grid: g, moduleSize: m, origin: { x: ox, y: oy }, gridSize: size };
    }
  }
  throw new Error('无法确定模块尺寸与网格（定位图案/定时图案校验均失败）');
}

/* --------------------------- GF(256) / RS --------------------------- */
const EXP = new Array(512).fill(0);
const LOG = new Array(256).fill(0);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = data.concat(new Array(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (!coef) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= mul(gen[j], coef);
  }
  return res.slice(-ecLen);
}

/* ------------------------------ 标准表 ------------------------------ */
// 独立抄录（和解码器一样，是从标准结构表来的；两边一致 + RS 重算通过 才算可信）
const EC_M = {
  1: [1, 16, 10], 2: [1, 28, 16], 3: [1, 44, 26], 4: [2, 32, 18], 5: [2, 33, 15],
  6: [4, 22, 16], 7: [4, 23, 17], 8: [2, 46, 20], 9: [3, 40, 20], 10: [4, 31, 24]
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
};
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0
];

const versionOf = (size) => (size - 17) / 4;

/** 重建「保留位图」：与编码端无关，纯按标准结构推出来 */
function reservedMap(size) {
  const version = versionOf(size);
  const res = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && r < size && c >= 0 && c < size) res[r][c] = true; };
  // 定位图案 + 分隔符
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) mark(r0 + dr, c0 + dc);
  }
  // 定时图案
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  // 校正图案
  for (const r of ALIGN[version] || []) {
    for (const c of ALIGN[version] || []) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  // 格式信息
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  // 版本信息
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { mark(size - 11 + j, i); mark(i, size - 11 + j); }
  }
  return res;
}

function bch15Valid(bits) {
  // 标准做法：先异或掉 QR 规范里的固定掩码 101010000010010，再检查能否被
  // 生成多项式整除。之前忘了异或掩码，导致编码器写对了也判 BAD（掩码破坏了整除性）。
  const g = 0b10100110111;
  let val = bits ^ 0b101010000010010;
  for (let i = 14; i >= 10; i--) if (val & (1 << i)) val ^= g << (i - 10);
  return val === 0;
}

/* ------------------------------ 解码 ------------------------------ */
function decodeQR(pngPath, expect) {
  const log = [];
  const png = decodePNG(fs.readFileSync(pngPath));
  const { grid, gridSize, moduleSize, origin } = extractModules(png);
  const version = versionOf(gridSize);
  log.push(`PNG ${png.width}x${png.height}, 模块网格 ${gridSize}x${gridSize} → 版本 ${version} (模块尺寸 ${moduleSize}px, 原点 ${origin.x},${origin.y})`);
  if (!Number.isInteger(version) || version < 1 || version > 40) throw new Error('版本号非整数: ' + version);
  if (process.argv.includes('--dump-grid')) {
    console.log('  提取到的网格前 9 行 / 前 9 列:');
    grid.slice(0, 9).forEach((row, i) => console.log('   r' + i + ' ' + row.join('').replace(/1/g, '#').replace(/0/g, '.')));
    console.log('   左上 9x9:');
    grid.slice(0, 9).forEach((row) => console.log('      ' + row.slice(0, 9).join('').replace(/1/g, '#').replace(/0/g, '.')));
  }

  // 定位图案校验
  const finderOK = (r0, c0) => {
    const want = [
      1, 1, 1, 1, 1, 1, 1,
      1, 0, 0, 0, 0, 0, 1,
      1, 0, 1, 1, 1, 0, 1,
      1, 0, 1, 1, 1, 0, 1,
      1, 0, 1, 1, 1, 0, 1,
      1, 0, 0, 0, 0, 0, 1,
      1, 1, 1, 1, 1, 1, 1
    ];
    let k = 0;
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) if (grid[r0 + r][c0 + c] !== want[k++]) return false;
    return true;
  };
  const finders = [finderOK(0, 0), finderOK(0, gridSize - 7), finderOK(gridSize - 7, 0)];
  log.push('定位图案(左上/右上/左下): ' + finders.map((v) => (v ? 'OK' : 'BAD')).join(' / '));
  if (!finders.every(Boolean)) throw new Error('定位图案损坏');

  // 定时图案校验
  let timingOK = true;
  for (let i = 8; i < gridSize - 8; i++) {
    if (grid[6][i] !== (i % 2 === 0 ? 1 : 0)) timingOK = false;
    if (grid[i][6] !== (i % 2 === 0 ? 1 : 0)) timingOK = false;
  }
  log.push('定时图案: ' + (timingOK ? 'OK' : 'BAD'));
  if (!timingOK) throw new Error('定时图案损坏');

  // 格式信息（副本 1，位置顺序与标准/编码器一致）
  const fmtSeq1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  let fmt = 0;
  fmtSeq1.forEach(([r, c], pos) => { if (grid[r][c]) fmt |= (1 << (14 - pos)); });
  if (process.argv.includes('--dump-fmt')) {
    console.log('  提取网格的格式位（p0..p14）: ' + fmtSeq1.map(([r, c]) => grid[r][c]).join(''));
    console.log('  组合出的 fmt = ' + fmt + ' (0b' + fmt.toString(2).padStart(15, '0') + ')');
    console.log('  bch15Valid = ' + bch15Valid(fmt));
  }
  const fmtValid = bch15Valid(fmt);
  let data5 = null;
  for (let d = 0; d < 32; d++) {
    const g = 0b10100110111;
    let val = d << 10;
    for (let i = 4; i >= 0; i--) if (val & (1 << (i + 10))) val ^= g << i;
    // 编码时格式信息会再异或规范掩码，这里必须同样带上，否则永远匹配不上
    const encoded = ((d << 10) | val) ^ 0b101010000010010;
    if (encoded === fmt) { data5 = d; break; }
  }
  log.push(`格式信息 0b${fmt.toString(2).padStart(15, '0')} BCH=${fmtValid ? 'OK' : 'BAD'} 纠错等级=${['M', 'L', 'H', 'Q'][(data5 >> 3) & 3]} 掩码=${data5 & 7}`);
  if (data5 === null) throw new Error('格式信息无法解析');

  // 交叉核对副本 2（右上 + 左下）
  const fmtSeq2 = [];
  for (let i = 0; i < 8; i++) fmtSeq2.push([8, gridSize - 1 - i]);
  for (let i = 0; i < 7; i++) fmtSeq2.push([gridSize - 7 + i, 8]);
  let fmt2 = 0;
  fmtSeq2.forEach(([r, c], pos) => { if (grid[r][c]) fmt2 |= (1 << (14 - pos)); });
  log.push('第二份格式信息一致: ' + (fmt2 === fmt ? 'OK' : '不一致(' + fmt2 + ' vs ' + fmt + ')'));

  const mask = data5 & 7;
  const ecl = (data5 >> 3) & 3;
  if (ecl !== 0) throw new Error('纠错等级不是 M（本工具只生成 M）: ' + ecl);

  // 去掩码
  const res = reservedMap(gridSize);
  const un = grid.map((row) => row.slice());
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (!res[r][c] && MASKS[mask](r, c)) un[r][c] ^= 1;
    }
  }

  // Z 字形读码字
  const bits = [];
  let col = gridSize - 1, upward = true;
  while (col > 0) {
    if (col === 6) col -= 1;
    for (let k = 0; k < gridSize; k++) {
      const r = upward ? gridSize - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (!res[r][c]) bits.push(un[r][c]);
      }
    }
    upward = !upward;
    col -= 2;
  }
  const cws = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    cws.push(v);
  }
  log.push(`读出码字 ${cws.length} 个（版本 ${version} 应为 ${EC_M[version][0] * (EC_M[version][1] + EC_M[version][2])} 个）`);

  // 反交织 + RS 重算
  const [blocks, perBlock, ecLen] = EC_M[version];
  const dataBlocks = Array.from({ length: blocks }, () => []);
  for (let i = 0; i < perBlock; i++) for (let b = 0; b < blocks; b++) dataBlocks[b].push(cws[i * blocks + b]);
  const ecStart = perBlock * blocks;
  let rsOK = true;
  for (let b = 0; b < blocks; b++) {
    const ec = [];
    for (let i = 0; i < ecLen; i++) ec.push(cws[ecStart + i * blocks + b]);
    const want = rsEncode(dataBlocks[b], ecLen);
    if (want.join(',') !== ec.join(',')) { rsOK = false; log.push(`  块 ${b} 纠错码字不匹配`); }
  }
  log.push('Reed-Solomon 纠错码字重算: ' + (rsOK ? '全部一致' : '不一致'));
  if (!rsOK) throw new Error('纠错码字与标准 RS 不一致');

  // 解析数据段
  const dataCws = [];
  dataBlocks.forEach((b) => dataCws.push(...b));
  const dbits = [];
  dataCws.forEach((cw) => { for (let i = 7; i >= 0; i--) dbits.push((cw >> i) & 1); });
  let idx = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | dbits[idx++]; return v; };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error('不是字节模式，mode=' + mode.toString(2));
  const count = take(version <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < count; i++) bytes.push(take(8));
  const text = Buffer.from(bytes).toString('utf8');
  log.push(`模式=字节, 长度=${count}, 文本="${text}"`);

  const ok = expect === undefined || expect === text;
  return { ok, text, version, mask, ecl: 'M', log };
}

/* ------------------------------- main ------------------------------- */
const args = process.argv.slice(2);
const pngPath = args[0];
const ei = args.indexOf('--expect');
const expect = ei >= 0 ? args[ei + 1] : undefined;
if (!pngPath) { console.error('用法: node tools/qr_reader.mjs <png> [--expect "原文"] [--dump-rows]'); process.exit(2); }

// 诊断模式：打印若干行的明暗段长，用来定位「找不到定位图案」这类问题
if (args.includes('--dump-rows')) {
  const png = decodePNG(fs.readFileSync(pngPath));
  const dark = (x, y) => {
    const i = (y * png.width + x) * png.channels;
    return (png.pixels[i] + png.pixels[i + 1] + png.pixels[i + 2]) / 3 < 128;
  };
  console.log(`PNG ${png.width}x${png.height} ch=${png.channels}`);
  const probes = [[32, 32], [40, 32], [88, 32], [96, 32], [120, 32], [32, 40], [32, 96], [200, 200]];
  for (const [x, y] of probes) {
    const i = (y * png.width + x) * png.channels;
    console.log(`  采样 (${x},${y}) rgb=${png.pixels[i]},${png.pixels[i + 1]},${png.pixels[i + 2]} dark=${dark(x, y)}`);
  }
  for (let y = 0; y < png.height; y++) {
    let x0 = -1;
    for (let x = 0; x < png.width; x++) if (dark(x, y)) { x0 = x; break; }
    if (x0 < 0) continue;
    const segs = [];
    let x = x0, want = true;
    while (x < png.width && segs.length < 8) {
      let run = 0;
      while (x < png.width && dark(x, y) === want) { run++; x++; }
      segs.push(run);
      want = !want;
    }
    const sum5 = segs.slice(0, 5).reduce((a, b) => a + b, 0);
    console.log(`y=${String(y).padStart(4)} x0=${String(x0).padStart(4)} segs=[${segs.join(',')}] sum5=${sum5}`);
  }
  process.exit(0);
}

try {
  const r = decodeQR(pngPath, expect);
  r.log.forEach((l) => console.log('  ' + l));
  console.log('\n独立解码结果: ' + (r.ok ? 'PASS' : 'FAIL') + (expect !== undefined ? `（期望 "${expect}"）` : ''));
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.log('独立解码失败: ' + e.message);
  process.exit(1);
}
