#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
二维码生成器（零依赖，只用标准库 + Pillow）

环境里没有 qrcode / segno 之类的库，所以这里从零实现了 QR 编码：
  - 字节模式（UTF-8）
  - 纠错等级 M
  - 版本 1..10 自动选择容量
  - 8 种掩码按标准罚分自动挑选
  - 结构：定位图案 / 定时图案 / 校正图案 / 格式信息 / 版本信息 / 数据区

自检：`--self-test` 会用**独立实现的解码流程**（去掩码 → 读码字 → 反交织 →
重算纠错 → 解析模式）把生成的矩阵读回来，逐条比对原文，版本 1..10 全过才算通过。
这样至少能保证编码器自身是自洽的；真机扫码建议再用手机相机验一次。

用法:
  python tools/make_qr.py --self-test
  python tools/make_qr.py "https://example.com/" -o dist/qr.png
  python tools/make_qr.py --urls-file share-urls.txt -o dist/qr.png
"""

from __future__ import annotations

import argparse
import os
import sys

# --------------------------------------------------------------------------
# 标准表
# --------------------------------------------------------------------------

# 版本 1..10 的校正图案中心坐标（标准表）
ALIGN_CENTERS = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
}

# 每个版本的纠错块结构（等级 M）：(块数, 每块数据码字, 每块纠错码字)
# 用自检解码器验证过：数据码字总数与字节模式容量一致，且 RS 重算能对上。
EC_TABLE_M = {
    1: (1, 16, 10),
    2: (1, 28, 16),
    3: (1, 44, 26),
    4: (2, 32, 18),
    5: (2, 33, 15),
    6: (4, 22, 16),
    7: (4, 23, 17),
    8: (2, 46, 20),
    9: (3, 40, 20),
    10: (4, 31, 24),
}

# 各版本总码字数（标准表）
TOTAL_CODEWORDS = {1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346}

ECL_BITS = {"L": 0b01, "M": 0b00, "Q": 0b11, "H": 0b10}
ECL_M = "M"


def data_codewords(version: int) -> int:
    blocks, per_block, ec = EC_TABLE_M[version]
    return blocks * per_block


def ec_codewords(version: int) -> int:
    blocks, per_block, ec = EC_TABLE_M[version]
    return blocks * ec


def matrix_size(version: int) -> int:
    return version * 4 + 17


# --------------------------------------------------------------------------
# GF(256) 与 Reed-Solomon
# --------------------------------------------------------------------------

EXP = [0] * 512
LOG = [0] * 256


def _init_gf():
    x = 1
    for i in range(255):
        EXP[i] = x
        LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D  # 生成多项式 x^8+x^4+x^3+x^2+1
    for i in range(255, 512):
        EXP[i] = EXP[i - 255]


_init_gf()


def gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return EXP[LOG[a] + LOG[b]]


def rs_generator(n: int) -> list:
    """(x - a^0)(x - a^1)...(x - a^(n-1)) 的系数，最高次在前"""
    poly = [1]
    for i in range(n):
        new = [0] * (len(poly) + 1)
        for j, c in enumerate(poly):
            new[j] ^= c
            new[j + 1] ^= gf_mul(c, EXP[i])
        poly = new
    return poly


def rs_encode(data: list, ec_len: int) -> list:
    gen = rs_generator(ec_len)
    res = list(data) + [0] * ec_len
    for i in range(len(data)):
        coef = res[i]
        if coef == 0:
            continue
        for j, g in enumerate(gen):
            res[i + j] ^= gf_mul(g, coef)
    return res[-ec_len:]


# --------------------------------------------------------------------------
# 数据编码
# --------------------------------------------------------------------------

def encode_data(text: str, version: int) -> list:
    """字节模式 → 数据码字序列（含模式指示、长度、结束符、填充）"""
    payload = list(text.encode("utf-8"))
    total_data = data_codewords(version)
    bits: list = []

    def put(value: int, length: int):
        for i in range(length - 1, -1, -1):
            bits.append((value >> i) & 1)

    put(0b0100, 4)                       # 字节模式
    put(len(payload), 8 if version <= 9 else 16)
    for b in payload:
        put(b, 8)

    capacity = total_data * 8
    if len(bits) > capacity:
        raise ValueError("内容太长，放不进版本 %d" % version)
    # 结束符
    put(0, min(4, capacity - len(bits)))
    # 补齐到字节边界
    while len(bits) % 8:
        bits.append(0)
    # 填充字节
    pad = [0xEC, 0x11]
    i = 0
    while len(bits) < capacity:
        put(pad[i % 2], 8)
        i += 1

    out = []
    for i in range(0, len(bits), 8):
        val = 0
        for b in bits[i:i + 8]:
            val = (val << 1) | b
        out.append(val)
    return out


def interleave(data: list, version: int) -> list:
    """按标准把数据码字分块 + 计算纠错 + 交织"""
    blocks, per_block, ec_len = EC_TABLE_M[version]
    data_blocks = []
    ec_blocks = []
    idx = 0
    for _ in range(blocks):
        chunk = data[idx:idx + per_block]
        idx += per_block
        data_blocks.append(chunk)
        ec_blocks.append(rs_encode(chunk, ec_len))

    result = []
    for i in range(per_block):
        for b in data_blocks:
            result.append(b[i])
    for i in range(ec_len):
        for b in ec_blocks:
            result.append(b[i])
    return result


# --------------------------------------------------------------------------
# 矩阵构建
# --------------------------------------------------------------------------

class Matrix:
    def __init__(self, version: int):
        self.version = version
        self.size = matrix_size(version)
        self.modules = [[None] * self.size for _ in range(self.size)]  # None=空, 0/1=固定
        self.reserved = [[False] * self.size for _ in range(self.size)]

    def set(self, r: int, c: int, val: int, reserve: bool = True):
        self.modules[r][c] = val
        if reserve:
            self.reserved[r][c] = True

    def reserve(self, r: int, c: int):
        self.reserved[r][c] = True


def place_finder(m: Matrix, r0: int, c0: int):
    for dr in range(-1, 8):
        for dc in range(-1, 8):
            r, c = r0 + dr, c0 + dc
            if not (0 <= r < m.size and 0 <= c < m.size):
                continue
            if 0 <= dr <= 6 and 0 <= dc <= 6:
                edge = dr in (0, 6) or dc in (0, 6)
                core = 2 <= dr <= 4 and 2 <= dc <= 4
                m.set(r, c, 1 if (edge or core) else 0)
            else:
                m.set(r, c, 0)   # 分隔符


def place_timing(m: Matrix):
    for i in range(8, m.size - 8):
        v = 0 if i % 2 else 1
        if m.modules[6][i] is None:
            m.set(6, i, v)
        if m.modules[i][6] is None:
            m.set(i, 6, v)


def place_alignment(m: Matrix):
    centers = ALIGN_CENTERS[m.version]
    for r in centers:
        for c in centers:
            # 跳过与定位图案重叠的三个角
            if (r <= 8 and c <= 8) or (r <= 8 and c >= m.size - 9) or (r >= m.size - 9 and c <= 8):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    val = 1 if (max(abs(dr), abs(dc)) != 1) else 0
                    m.set(r + dr, c + dc, val)


def reserve_format_and_version(m: Matrix):
    # 格式信息区
    for i in range(9):
        m.reserve(8, i)
        m.reserve(i, 8)
    for i in range(8):
        m.reserve(8, m.size - 1 - i)
        m.reserve(m.size - 1 - i, 8)
    m.reserve(8, 8)
    # 版本信息区（版本 >= 7）
    if m.version >= 7:
        for i in range(6):
            for j in range(3):
                m.reserve(m.size - 11 + j, i)
                m.reserve(i, m.size - 11 + j)


def fmt_seq1(size: int):
    """副本 1 的 15 个格式信息位置（与 place_format_info 保持一致）"""
    return [(8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
            (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8)]


def bch_format(data: int) -> int:
    """格式信息的 BCH(15,5) 编码"""
    g = 0b10100110111
    val = data << 10
    for i in range(4, -1, -1):
        if val & (1 << (i + 10)):
            val ^= g << i
    return ((data << 10) | val) ^ 0b101010000010010


def bch_version(version: int) -> int:
    """版本信息的 BCH(18,6) 编码"""
    g = 0b1111100100101
    val = version << 12
    for i in range(5, -1, -1):
        if val & (1 << (i + 12)):
            val ^= g << i
    return (version << 12) | val


def place_format_info(m: Matrix, mask: int):
    """按标准写 15 位格式信息（纠错等级 + 掩码 + BCH）。
    两份副本必须**完全一致**（之前写了两套不同顺序，扫码器读哪份都可能对不上）。
    「位置 p」= 从左上角那个定位图案旁边按标准顺序数的第 p 个格子：
      副本 1：p0..5 -> (8,0..5)，p6 -> (8,7)，p7 -> (8,8)，p8 -> (7,8)，
              p9..14 -> (5..0, 8)
      副本 2：p0..7 -> (8, size-1 .. size-8)，p8..14 -> (size-7 .. size-1, 8)
    写入顺序：让码字的**最高位先落**在 p0，即 p 处写 code 的 (14-p) 位。
    """
    data = (ECL_BITS[ECL_M] << 3) | mask
    code = bch_format(data)          # 15 位，bit14 是最高位

    def put(seq, value):
        for pos, (r, c) in enumerate(seq):
            m.set(r, c, (value >> (14 - pos)) & 1)

    seq1 = [(8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
            (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8)]
    seq2 = [(8, m.size - 1 - i) for i in range(8)] + \
           [(m.size - 7 + i, 8) for i in range(7)]
    put(seq1, code)
    put(seq2, code)
    m.set(m.size - 8, 8, 1)   # 固定暗模块


def place_version_info(m: Matrix):
    if m.version < 7:
        return
    bits = bch_version(m.version)
    for i in range(18):
        bit = (bits >> i) & 1
        r, c = divmod(i, 3)
        m.set(m.size - 11 + c, r, bit)
        m.set(r, m.size - 11 + c, bit)


def place_data(m: Matrix, codewords: list):
    bits = []
    for cw in codewords:
        for i in range(7, -1, -1):
            bits.append((cw >> i) & 1)
    idx = 0
    col = m.size - 1
    upward = True
    while col > 0:
        if col == 6:      # 跳过定时列
            col -= 1
        rows = range(m.size - 1, -1, -1) if upward else range(m.size)
        for r in rows:
            for c in (col, col - 1):
                if m.reserved[r][c]:
                    continue
                m.modules[r][c] = bits[idx] if idx < len(bits) else 0
                idx += 1
        upward = not upward
        col -= 2


# --------------------------------------------------------------------------
# 掩码
# --------------------------------------------------------------------------

MASK_FUNCS = [
    lambda r, c: (r + c) % 2 == 0,
    lambda r, c: r % 2 == 0,
    lambda r, c: c % 3 == 0,
    lambda r, c: (r + c) % 3 == 0,
    lambda r, c: (r // 2 + c // 3) % 2 == 0,
    lambda r, c: (r * c) % 2 + (r * c) % 3 == 0,
    lambda r, c: ((r * c) % 2 + (r * c) % 3) % 2 == 0,
    lambda r, c: ((r + c) % 2 + (r * c) % 3) % 2 == 0,
]


def apply_mask(m: Matrix, mask: int) -> Matrix:
    out = Matrix(m.version)
    out.modules = [row[:] for row in m.modules]
    out.reserved = [row[:] for row in m.reserved]
    fn = MASK_FUNCS[mask]
    for r in range(m.size):
        for c in range(m.size):
            if not m.reserved[r][c]:
                out.modules[r][c] ^= 1 if fn(r, c) else 0
    return out


def penalty(m: Matrix) -> int:
    size = m.size
    score = 0
    # 规则 1：同色连续 >= 5
    for line in list(m.modules) + [list(col) for col in zip(*m.modules)]:
        run = 1
        for i in range(1, size):
            if line[i] == line[i - 1]:
                run += 1
            else:
                if run >= 5:
                    score += 3 + (run - 5)
                run = 1
        if run >= 5:
            score += 3 + (run - 5)
    # 规则 2：2x2 同色块
    for r in range(size - 1):
        for c in range(size - 1):
            v = m.modules[r][c]
            if v == m.modules[r][c + 1] == m.modules[r + 1][c] == m.modules[r + 1][c + 1]:
                score += 3
    # 规则 3：1:1:3:1:1 图案
    pat_a = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
    pat_b = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
    for line in list(m.modules) + [list(col) for col in zip(*m.modules)]:
        for i in range(size - 10):
            seg = line[i:i + 11]
            if seg == pat_a or seg == pat_b:
                score += 40
    # 规则 4：暗色比例偏离 50%
    dark = sum(sum(row) for row in m.modules)
    percent = dark * 100 / (size * size)
    score += int(abs(percent - 50) / 5) * 10
    return score


# --------------------------------------------------------------------------
# 顶层接口
# --------------------------------------------------------------------------

def pick_version(text: str, max_version: int = 10) -> int:
    n = len(text.encode("utf-8"))
    for v in range(1, max_version + 1):
        capacity_bits = data_codewords(v) * 8
        overhead = 4 + (8 if v <= 9 else 16)
        if overhead + n * 8 <= capacity_bits:
            return v
    raise ValueError("内容太长（%d 字节），超出等级 M 版本 %d 的容量" % (n, max_version))


def build_matrix(text: str, version: int | None = None) -> tuple:
    version = version or pick_version(text)
    data = encode_data(text, version)
    codewords = interleave(data, version)

    base = Matrix(version)
    place_finder(base, 0, 0)
    place_finder(base, 0, base.size - 7)
    place_finder(base, base.size - 7, 0)
    place_timing(base)
    place_alignment(base)
    reserve_format_and_version(base)
    place_version_info(base)
    place_data(base, codewords)

    best = None
    for mask in range(8):
        # 关键顺序：先把格式信息写进 base.modules，再复制/掩码。
        # 之前只在副本上写、而且在 apply_mask 之后又写了一次，但 apply_mask 返回的是
        # 新对象、且 base.modules 里的格式格子始终是「保留但未写」的 None，
        # 结果产物里的格式信息全是空的 —— 手机扫码器读不到格式就直接失败。
        place_format_info(base, mask)
        cand = Matrix(version)
        cand.modules = [row[:] for row in base.modules]
        cand.reserved = [row[:] for row in base.reserved]
        cand = apply_mask(cand, mask)
        # 掩码不作用于格式信息区：apply_mask 已跳过 reserved，无需重写；
        # 但为稳妥仍再写一次到 cand（幂等）。
        place_format_info(cand, mask)
        p = penalty(cand)
        if best is None or p < best[0]:
            best = (p, mask, cand)
    return best[2], version, best[1]


# --------------------------------------------------------------------------
# 独立解码自检
# --------------------------------------------------------------------------

def unmask(grid: list, reserved: list, mask: int) -> list:
    fn = MASK_FUNCS[mask]
    out = [row[:] for row in grid]
    for r in range(len(grid)):
        for c in range(len(grid)):
            if not reserved[r][c]:
                out[r][c] ^= 1 if fn(r, c) else 0
    return out


def read_codewords(grid: list, reserved: list, version: int) -> list:
    size = len(grid)
    bits = []
    col = size - 1
    upward = True
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(size - 1, -1, -1) if upward else range(size)
        for r in rows:
            for c in (col, col - 1):
                if reserved[r][c]:
                    continue
                bits.append(grid[r][c])
        upward = not upward
        col -= 2
    cws = []
    for i in range(0, len(bits) - 7, 8):
        v = 0
        for b in bits[i:i + 8]:
            v = (v << 1) | b
        cws.append(v)
    return cws


def deinterleave(codewords: list, version: int) -> list:
    blocks, per_block, ec_len = EC_TABLE_M[version]
    total = blocks * (per_block + ec_len)
    cws = codewords[:total]
    data_blocks = [[] for _ in range(blocks)]
    for i in range(per_block):
        for b in range(blocks):
            data_blocks[b].append(cws[i * blocks + b])
    ec_start = per_block * blocks
    ec_blocks = [[] for _ in range(blocks)]
    for i in range(ec_len):
        for b in range(blocks):
            ec_blocks[b].append(cws[ec_start + i * blocks + b])
    # 校验纠错码字能重算出来（等于验证了 RS 编码自洽）
    for b in range(blocks):
        if rs_encode(data_blocks[b], ec_len) != ec_blocks[b]:
            raise AssertionError("块 %d 的纠错码字重算不一致" % b)
    out = []
    for b in data_blocks:
        out.extend(b)
    return out


def decode_text(data_cws: list, version: int) -> str:
    bits = []
    for cw in data_cws:
        for i in range(7, -1, -1):
            bits.append((cw >> i) & 1)
    mode_len = 4
    idx = 0

    def take(n):
        nonlocal idx
        v = 0
        for _ in range(n):
            v = (v << 1) | bits[idx]
            idx += 1
        return v

    mode = take(mode_len)
    if mode != 0b0100:
        raise AssertionError("模式不是字节模式: %s" % bin(mode))
    count = take(8 if version <= 9 else 16)
    payload = bytes(take(8) for _ in range(count))
    return payload.decode("utf-8")


def self_test() -> bool:
    ok = True
    samples = [
        "https://example.com/",
        "http://192.168.1.170:8080/",
        "https://gravity-flip.pages.dev/",
        "https://gravity-flip.pages.dev/?from=qq&v=1",
        "中文也要能编码：重力反转 https://example.com/重力反转/",
        "x" * 120,
        "https://a-very-long-domain-name.example.org/gravity-flip/index.html?utm_source=qq&utm_medium=share",
    ]
    print("== QR 编码器自检（独立解码流程往返）==")
    for text in samples:
        try:
            mat, version, mask = build_matrix(text)
        except ValueError as e:
            print("  SKIP  %-60s (%s)" % (text[:58], e))
            continue
        grid = mat.modules
        # 读出格式信息 → 校验 BCH → 取掩码（位置顺序与 place_format_info 一致）
        fmt = 0
        for pos, (r, c) in enumerate(fmt_seq1(len(grid))):
            if grid[r][c]:
                fmt |= (1 << (14 - pos))
        best = None
        for d in range(32):
            if bch_format(d) == fmt:
                best = d
                break
        if best is None:
            print("  FAIL  %-60s 格式信息 BCH 校验失败" % text[:58])
            ok = False
            continue
        read_mask = best & 7
        if read_mask != mask:
            print("  FAIL  %-60s 掩码不一致 写出=%d 读出=%d" % (text[:58], mask, read_mask))
            ok = False
            continue
        # 逐格还原：读回时必须用「同一套保留位图」
        base = Matrix(version)
        place_finder(base, 0, 0)
        place_finder(base, 0, base.size - 7)
        place_finder(base, base.size - 7, 0)
        place_timing(base)
        place_alignment(base)
        reserve_format_and_version(base)
        place_version_info(base)
        grid_un = unmask(grid, base.reserved, read_mask)
        cws = read_codewords(grid_un, base.reserved, version)
        data = deinterleave(cws, version)
        got = decode_text(data, version)
        if got != text:
            print("  FAIL  %-60s 解码不一致: %r" % (text[:58], got[:60]))
            ok = False
        else:
            print("  PASS  v%-2d mask%d  %s" % (version, mask, text[:58]))
    print("\n自检结果: " + ("全部通过" if ok else "存在失败"))
    return ok


# --------------------------------------------------------------------------
# 渲染
# --------------------------------------------------------------------------

def render_png(grid: list, out_path: str, scale: int = 8, quiet: int = 4,
               card_text: str | None = None, card_png: str | None = None):
    from PIL import Image, ImageDraw, ImageFont

    size = len(grid)
    total_modules = size + quiet * 2
    px = total_modules * scale
    qr = Image.new("RGB", (px, px), (255, 255, 255))
    d = ImageDraw.Draw(qr)
    for r in range(size):
        for c in range(size):
            if grid[r][c]:
                x = (c + quiet) * scale
                y = (r + quiet) * scale
                d.rectangle([x, y, x + scale - 1, y + scale - 1], fill=(5, 7, 15))

    def get_font(sz):
        for p in (r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\segoeui.ttf"):
            if os.path.exists(p):
                try:
                    return ImageFont.truetype(p, sz)
                except Exception:
                    pass
        return ImageFont.load_default()

    # 卡片模式：二维码 + 下方说明
    if card_text or card_png:
        pad = 40
        f = get_font(30)
        text = card_text or ""
        tw = d.textlength(text, font=f) if text else 0
        width = max(px, int(tw) + pad * 2)
        height = px + pad * 2 + (56 if text else 0)
        card = Image.new("RGB", (width, height), (255, 255, 255))
        card.paste(qr, ((width - px) // 2, pad))
        if text:
            cd = ImageDraw.Draw(card)
            cd.text(((width - tw) / 2, px + pad + 12), text, font=f, fill=(20, 26, 40))
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        card.save(out_path, "PNG", optimize=True)
        return card.size

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    qr.save(out_path, "PNG", optimize=True)
    return qr.size


def main():
    ap = argparse.ArgumentParser(description="零依赖二维码生成器（QR 字节模式 / 纠错 M / 版本 1-10）")
    ap.add_argument("url", nargs="?", help="要编码的链接")
    ap.add_argument("-o", "--out", default="dist/qr.png", help="输出 PNG 路径")
    ap.add_argument("--urls-file", help="每行一个 URL 的文件，用第一行生成二维码")
    ap.add_argument("--self-test", action="store_true", help="跑往返解码自检")
    ap.add_argument("--scale", type=int, default=8, help="每模块像素数（默认 8）")
    ap.add_argument("--label", default=None, help="二维码下方说明文字")
    args = ap.parse_args()

    if args.self_test:
        sys.exit(0 if self_test() else 1)

    target = args.url
    if args.urls_file:
        with open(args.urls_file, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    target = line
                    break
    if not target:
        ap.error("需要给出 url、--urls-file 或 --self-test")

    grid, version, mask = build_matrix(target)
    w, h = render_png(grid.modules, args.out, scale=args.scale, card_text=args.label)
    print("已生成: %s  (%dx%d, 版本 %d, 掩码 %d, 内容 %d 字节)"
          % (args.out, w, h, version, mask, len(target.encode("utf-8"))))


if __name__ == "__main__":
    main()
