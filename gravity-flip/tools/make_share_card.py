#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成微信/QQ 分享卡片图：gravity-flip/dist/share-card.png (1200x630)

用游戏真实的绘制规则（同色板、同物理常量）渲染一个关卡画面，
比随便找张图更有说服力。可复现：不依赖游戏引擎，纯 Pillow 重绘。

用法:
  python tools/make_share_card.py                 # 直接画一张代表性画面
  python tools/make_share_card.py <screenshot.png>  # 若有真机截图，裁切后作为底图
"""

import os
import sys
import math

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "dist", "share-card.png")
W, H = 1200, 630
TILE = 40
GROUND, CEIL = 16, 4
PW, PH = 24, 28

BG = (5, 7, 15)
CYAN = (34, 211, 238)
CYAN_SOFT = (103, 232, 249)
MAGENTA = (244, 114, 182)
YELLOW = (253, 224, 71)
GREEN = (74, 222, 128)
TILE_FILL = (11, 20, 36)
TEXT = (232, 238, 252)
DIM = (140, 158, 190)


def find_font(bold=False):
    cands = [
        r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    return None


def font(size, bold=False):
    p = find_font(bold)
    if p:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()


def rounded(draw, box, r, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def star(draw, cx, cy, r, fill):
    pts = []
    for i in range(10):
        rr = r if i % 2 == 0 else r * 0.45
        a = math.pi / 5 * i - math.pi / 2
        pts.append((cx + math.cos(a) * rr, cy + math.sin(a) * rr))
    draw.polygon(pts, fill=fill)


def draw_scene(img):
    """用游戏的配色与几何画一关的代表性画面（右半部分）"""
    d = ImageDraw.Draw(img, "RGBA")
    # 网格
    for x in range(0, W, TILE):
        d.line([(x, 0), (x, H)], fill=(34, 211, 238, 10), width=1)
    for y in range(0, H, TILE):
        d.line([(0, y), (W, y)], fill=(34, 211, 238, 10), width=1)

    ground_y = GROUND * TILE
    ceil_y = CEIL * TILE

    # 实心块：地面 + 两段天花板 + 一根柱子
    blocks = [(c, GROUND) for c in range(10, 30)]
    blocks += [(c, CEIL) for c in range(10, 20)]
    blocks += [(c, CEIL) for c in range(26, 30)]
    blocks += [(c, r) for c in range(21, 23) for r in range(9, GROUND)]
    for (c, r) in blocks:
        x, y = c * TILE, r * TILE
        d.rectangle([x, y, x + TILE, y + TILE], fill=TILE_FILL, outline=(34, 211, 238, 60), width=1)

    # 地面尖刺（在刺坑里，朝向朝上）
    for c in range(15, 19):
        x = c * TILE
        d.polygon([(x + 7, ground_y - 2), (x + TILE / 2, ground_y - 20), (x + TILE - 7, ground_y - 2)], fill=MAGENTA)

    # 天花板尖刺（朝下）
    for c in range(24, 26):
        x = c * TILE
        d.polygon([(x + 7, ceil_y + TILE + 2), (x + TILE / 2, ceil_y + TILE + 20), (x + TILE - 7, ceil_y + TILE + 2)], fill=MAGENTA)

    # 三颗星：地面泳道 / 空中 / 天花板泳道
    star(d, 12 * TILE + 20, ground_y - 20, 16, YELLOW)
    star(d, 17 * TILE + 20, 9 * TILE + 20, 16, YELLOW)
    star(d, 28 * TILE + 20, ceil_y + TILE + 20, 15, YELLOW)

    # 玩家：贴在天花板下面（重力朝上）
    px, py = 13 * TILE + 20, ceil_y + TILE + PH / 2
    d.rounded_rectangle([px - PW / 2, py - PH / 2, px + PW / 2, py + PH / 2], radius=6,
                        fill=CYAN_SOFT, outline=CYAN, width=2)
    d.rounded_rectangle([px - PW / 2 + 4, py - PH / 2 + 5, px + PW / 2 - 4, py - PH / 2 + 13], radius=3, fill=(5, 7, 15))
    # 重力方向箭头（朝上 = 被天花板吸引）
    d.line([(px, py - PH / 2 - 10), (px, py - PH / 2 - 30)], fill=CYAN, width=3)
    d.polygon([(px - 6, py - PH / 2 - 28), (px + 6, py - PH / 2 - 28), (px, py - PH / 2 - 40)], fill=CYAN)

    # 出口门（右侧天花板）
    ex, ey = 27 * TILE + 20, ceil_y + TILE + PH / 2
    rounded(d, [ex - 19, ey - 19, ex + 19, ey + 19], 8, outline=GREEN, width=3)
    d.line([(ex - 7, ey), (ex + 7, ey)], fill=GREEN, width=3)
    d.line([(ex + 3, ey - 5), (ex + 8, ey), (ex + 3, ey + 5)], fill=GREEN, width=3)


def left_panel(img):
    d = ImageDraw.Draw(img, "RGBA")
    # 左侧压暗，保证文字可读
    grad = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for x in range(0, 760):
        a = int(235 * (1 - x / 760) ** 0.85)
        gd.line([(x, 0), (x, H)], fill=(5, 7, 15, a))
    img.alpha_composite(grad)

    d = ImageDraw.Draw(img, "RGBA")
    d.text((72, 96), "重力反转", font=font(86, True), fill=TEXT)
    d.text((72, 196), "GRAVITY FLIP", font=font(38, True), fill=CYAN)
    d.text((72, 268), "按一下，天花板就变成地板", font=font(30), fill=DIM)

    feats = [
        ("Z", "一个键翻转重力"),
        ("12", "关卡 · 每关 3 星"),
        ("0", "依赖 · 单文件 · 离线可玩"),
    ]
    y = 344
    kb = font(26, True)
    for key, desc in feats:
        box = [72, y - 6, 72 + 58, y + 42]
        # 高对比徽章：实心青底 + 深色数字（青字压在青底上会完全看不见，已踩过）
        rounded(d, box, 10, fill=CYAN)
        tw = d.textlength(key, font=kb)
        d.text((72 + 29 - tw / 2, y + 18 - kb.size / 2 - 1), key, font=kb, fill=(4, 16, 26))
        d.text((146, y + 2), desc, font=font(26), fill=TEXT)
        y += 62


def bottom_bar(img):
    d = ImageDraw.Draw(img, "RGBA")
    d.text((72, H - 58), "打开即玩 · 手机也能玩 · 进度存在本机", font=font(24), fill=DIM)


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    shot = sys.argv[1] if len(sys.argv) > 1 else None

    img = Image.new("RGBA", (W, H), BG + (255,))
    # 极淡径向渐变
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([W * 0.45, -H * 0.5, W * 1.5, H * 1.4], fill=(34, 211, 238, 16))
    img.alpha_composite(glow)

    if shot and os.path.exists(shot):
        s = Image.open(shot).convert("RGBA")
        # 按高度铺满，居中裁切
        scale = H / s.height
        s = s.resize((int(s.width * scale), H), Image.LANCZOS)
        if s.width > W:
            left = (s.width - W) // 2
            s = s.crop((left, 0, left + W, H))
        img.alpha_composite(s)
    else:
        draw_scene(img)

    left_panel(img)
    bottom_bar(img)

    # 暗角
    vg = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    vd = ImageDraw.Draw(vg)
    vd.rectangle([0, 0, W, 8], fill=(0, 0, 0, 90))
    vd.rectangle([0, H - 8, W, H], fill=(0, 0, 0, 90))
    img.alpha_composite(vg)

    img.convert("RGB").save(OUT, "PNG", optimize=True)
    print("已生成:", os.path.relpath(OUT, ROOT), os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
