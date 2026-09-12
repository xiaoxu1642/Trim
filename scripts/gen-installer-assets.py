#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/gen-installer-assets.py — 生成 NSIS 安装器品牌位图资源（24bit BMP）

批次：Installer 视觉升级 v3.2（2026-09-12，薰衣草渐变 + 跟随聚光）
为什么需要它：
  NSIS 的 nsDialogs/Static 控件不支持运行时绘图，渐变、圆角、光效全部必须预渲染成 BMP。
  本脚本是这些 BMP 的「唯一事实源」（与 scripts/fix_icons.py 同策略）。
视觉授权：
  安装器是发布触点，经用户确认放宽 AGENTS.md §5 的「禁彩色渐变 / 圆角 ≤8px」，
  但**只在安装器位图范围内**：应用内 UI 仍只用 main.css token、仍禁渐变。
设计 token（薰衣草单色系，取自 src/styles/main.css :root 深色集）：
  hero 135° #20214A → #171832 45% → #141419
  accent #8B8EE0 / accent-hover #A6A9F2 / accent-press #7174CC
  fg #F4F6FA / fg2 #C3C9D4 / fg3 #8B93A5
  卡片 rgba(255,255,255,.04) + 描边 rgba(139,142,224,.18)；圆角 12px
输出：build/installer/*.bmp（installer.nsh 在 onInit 期 File 进 $PLUGINSDIR）
用法：python scripts/gen-installer-assets.py
"""
import math
import os
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- token
HERO_A = (32, 33, 74)      # #20214A
HERO_B = (23, 24, 50)      # #171832
HERO_C = (20, 20, 25)      # #141419
INK = (16, 16, 22)         # 最暗角
CARD = (37, 38, 58)        # 卡片面（深紫底叠白 4%）
INPUT = (36, 41, 54)       # 输入槽 #242936
ACC = (139, 142, 224)      # #8B8EE0
ACC_L = (166, 169, 242)    # #A6A9F2
ACC_D = (113, 116, 204)    # #7174CC
BORDER = (58, 60, 94)      # 卡片描边（薰衣草叠底）
BORDER_HI = (86, 89, 150)  # 高亮描边
FG = (244, 246, 250)
FG2 = (195, 201, 212)
FG3 = (139, 147, 165)
OK = (52, 199, 123)
OK_D = (24, 122, 74)
DISABLED_A = (58, 61, 85)
DISABLED_B = (46, 48, 73)
DISABLED_FG = (139, 147, 165)

# ---------------------------------------------------------------- 几何
PAGE_W, PAGE_H = 640, 396      # 页面区（客户区 640×440 − 底部 44px 按钮条）
FOOTER_H = 44
BANNER_H = 56
SPOT_SIZE = 440                # 跟随聚光贴图边长（半径 220，对齐 motion-lab 默认值）
S = 2                          # 超采样倍数：先 2x 绘制再 LANCZOS 缩回

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "installer")


def font(size, bold=False):
    candidates = [
        r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\segoeui.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, int(size * S))
            except Exception:
                pass
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def canvas(w=PAGE_W, h=PAGE_H, bg=HERO_B):
    img = Image.new("RGB", (w * S, h * S), bg)
    return img, ImageDraw.Draw(img)


def save(img, name, size=None):
    """统一出口：2x 降采样 → 24bit BMP（SS_BITMAP/LoadImage 要求无 alpha）。"""
    target = size or (PAGE_W, PAGE_H)
    if img.size != target:
        img = img.resize(target, Image.LANCZOS)
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    img.save(path, "BMP")
    print("生成:", name, target)


def rrect(d, box, radius, fill=None, outline=None, width=1):
    x0, y0, x1, y1 = box
    d.rounded_rectangle((x0 * S, y0 * S, x1 * S, y1 * S), radius=radius * S,
                        fill=fill, outline=outline, width=max(1, int(width * S)))


def text(d, xy, s, fill, f, anchor=None):
    d.text((xy[0] * S, xy[1] * S), s, fill=fill, font=f, anchor=anchor)


def diag_grad(img, c1=HERO_A, c2=HERO_B, c3=HERO_C):
    """135° 三段渐变：左上 c1 → 45% c2 → 右下 c3（逐行扫描，2x 画布）。"""
    d = ImageDraw.Draw(img)
    w, h = img.size
    span = w + h
    for i in range(0, span, 1):
        # 沿对角线方向取色
        t = i / span
        if t < 0.45:
            c = lerp(c1, c2, t / 0.45)
        else:
            c = lerp(c2, c3, (t - 0.45) / 0.55)
        # 该对角线位置的像素带
        x0 = max(0, i - h)
        x1 = min(w, i)
        d.line([(x0, min(h, i)), (x1, max(0, i - w))], fill=c, width=1)


def glow(img, cx, cy, radius, color=ACC, strength=0.34):
    """柔光：把 color 以平方衰减叠加到底图上（无 alpha 通道，必须合成）。"""
    w, h = img.size
    px = img.load()
    x0 = max(0, int((cx - radius) * S)); x1 = min(w, int((cx + radius) * S))
    y0 = max(0, int((cy - radius) * S)); y1 = min(h, int((cy + radius) * S))
    r = radius * S
    for y in range(y0, y1):
        dy = (y - cy * S) / r
        for x in range(x0, x1):
            dx = (x - cx * S) / r
            dist = math.sqrt(dx * dx + dy * dy)
            if dist >= 1.0:
                continue
            f = (1.0 - dist) ** 2 * strength
            c = px[x, y]
            px[x, y] = (
                min(255, round(c[0] + (color[0] - c[0]) * f)),
                min(255, round(c[1] + (color[1] - c[1]) * f)),
                min(255, round(c[2] + (color[2] - c[2]) * f)),
            )


def dim(img, factor=0.86):
    """整体压暗：呼应 motion-lab「聚光外区域变暗」，由跟随聚光层局部提亮。"""
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            c = px[x, y]
            px[x, y] = (round(c[0] * factor), round(c[1] * factor), round(c[2] * factor))


def logo_mark(d, x, y, size=32):
    """品牌标记：竖向渐变的圆角方块 + 深色 T（渐变用逐行划线实现）。"""
    r = int(size * 0.28)
    # 先画圆角矩形底（渐变的近似：上下两段插值，逐行）
    for i in range(int(size * S)):
        t = i / (size * S)
        c = lerp(ACC_L, ACC_D, t)
        d.line([((x) * S, y * S + i), ((x + size) * S, y * S + i)], fill=c, width=1)
    # 用圆角遮罩抠圆角
    mask = Image.new("L", (int(size * S), int(size * S)), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, int(size * S), int(size * S)), radius=r * S, fill=255)
    return mask


def logo(x, y, size=32):
    """圆角渐变品牌块 + T：返回 (mask, box)，由调用方粘贴。"""
    w = int(size * S)
    grad = Image.new("RGB", (w, w))
    gd = ImageDraw.Draw(grad)
    for i in range(w):
        gd.line([(0, i), (w, i)], fill=lerp(ACC_L, ACC_D, i / w))
    gd.text((w / 2, w / 2 + 1 * S), "T", fill=(23, 24, 50), font=font(int(size * 0.52), bold=True), anchor="mm")
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, w - 1), radius=int(size * 0.28) * S, fill=255)
    return grad, mask


def paste_logo(img, x, y, size=32):
    grad, mask = logo(x, y, size)
    img.paste(grad, (int(x * S), int(y * S)), mask)


def check_mark(d, cx, cy, r=9, color=(23, 24, 50), width=3):
    d.line([(cx - r * 0.55, cy + r * 0.05), (cx - r * 0.1, cy + r * 0.5)], fill=color, width=width * S)
    d.line([(cx - r * 0.1, cy + r * 0.5), (cx + r * 0.6, cy - r * 0.45)], fill=color, width=width * S)


def hero_page(dimmed=True, with_logo=True, title=None, subtitle=None):
    img, d = canvas()
    diag_grad(img)
    d = ImageDraw.Draw(img)
    glow(img, 120, 40, 320, ACC, 0.30)      # 左上光晕
    glow(img, 560, 330, 300, ACC_D, 0.16)   # 右下补光
    if dimmed:
        dim(img, 0.86)
    d = ImageDraw.Draw(img)
    if with_logo:
        paste_logo(img, 26, 18, 32)
        text(d, (68, 34), "Trim 安装程序", FG, font(15, bold=True), anchor="lm")
    if title:
        text(d, (26, 78), title, FG, font(20, bold=True))
    if subtitle:
        text(d, (26, 112), subtitle, FG3, font(12))
    return img, d


# ---------------------------------------------------------------- 页面：安装选项
def page_setup():
    """页 1：安装选项（合并原欢迎页 + 选项页），控件槽位与 installer.nsh 常量一一对应。"""
    img, d = hero_page(
        dimmed=True,
        title="选择安装位置",
        subtitle="Trim 将安装到下面的文件夹，预计占用 186 MB。",
    )
    # 路径输入槽（原生 EDIT 叠在上面：x=32,y=132,w=458,h=30）
    rrect(d, (26, 126, 496, 168), 12, fill=INPUT, outline=BORDER_HI, width=1)
    # 选项卡 1 / 2（原生勾选框位图 + 透明标签叠在上面）
    for i, y in enumerate((182, 246)):
        rrect(d, (26, y, 614, y + 52), 12, fill=CARD, outline=BORDER, width=1)
        text(d, (72, y + 26), "创建桌面快捷方式" if i == 0 else "创建开始菜单快捷方式",
             FG2, font(12.5), anchor="lm")
        text(d, (596, y + 26), "推荐" if i == 0 else "可选", FG3, font(11), anchor="rm")
    # 提示行
    text(d, (26, 322), "需要至少 250 MB 可用空间 · 仅为你（当前用户）安装，不需要管理员权限", FG3, font(11.5))
    save(img, "page-setup.bmp")


# ---------------------------------------------------------------- 页面：安装完成
def page_finish():
    img, d = hero_page(dimmed=True, title=None, subtitle=None)
    cx = PAGE_W // 2
    # 成功标记：径向绿光 + 对勾
    glow(img, cx, 108, 96, OK, 0.30)
    d = ImageDraw.Draw(img)
    d.ellipse([(cx - 31) * S, 77 * S, (cx + 31) * S, 139 * S], fill=(24, 62, 47), outline=(38, 122, 82), width=1 * S)
    d.line([(cx - 13) * S, 108 * S, (cx - 4) * S, 118 * S], fill=OK, width=4 * S)
    d.line([(cx - 4) * S, 118 * S, (cx + 14) * S, 96 * S], fill=OK, width=4 * S)
    text(d, (cx, 168), "安装完成", FG, font(20, bold=True), anchor="mm")
    text(d, (cx, 196), "Trim 已安装到你的计算机，可从桌面或开始菜单启动。", FG3, font(12), anchor="mm")
    # 统计三格（数值由原生透明标签叠上）
    bw, gap, y = 186, 12, 224
    x0 = (PAGE_W - bw * 3 - gap * 2) // 2
    for i in range(3):
        x = x0 + i * (bw + gap)
        rrect(d, (x, y, x + bw, y + 64), 12, fill=CARD, outline=BORDER, width=1)
        # 顶部 2px 渐变强调条
        for k in range(2 * S):
            t = k / (2 * S)
            d.line([(x * S + 8 * S, y * S + k), ((x + bw) * S - 8 * S, y * S + k)], fill=lerp(ACC_L, ACC_D, t))
        text(d, (x + bw / 2, y + 46), ("版本号", "安装大小", "安装耗时")[i], FG3, font(11), anchor="mm")
    save(img, "page-finish.bmp")


# ---------------------------------------------------------------- 页面：卸载
def page_uninstall():
    img, d = hero_page(
        dimmed=True,
        title="卸载 Trim",
        subtitle="将从你的计算机移除 Trim，设置与清理记录可以保留。",
    )
    rrect(d, (26, 156, 614, 208), 12, fill=CARD, outline=BORDER, width=1)
    text(d, (72, 182), "保留我的配置与清理记录", FG2, font(12.5), anchor="lm")
    text(d, (596, 182), "推荐", FG3, font(11), anchor="rm")
    rrect(d, (26, 220, 614, 328), 12, fill=(30, 30, 48), outline=BORDER, width=1)
    text(d, (44, 240), "卸载将移除：", FG2, font(12, bold=True))
    for i, line in enumerate(("程序文件与桌面 / 开始菜单快捷方式",
                              "开机启动项与右键菜单注册",
                              "卸载信息（应用和功能里的条目）")):
        d.ellipse([(46) * S, (268 + i * 20) * S, (50) * S, (272 + i * 20) * S], fill=ACC)
        text(d, (60, 270 + i * 20), line, FG3, font(11.5), anchor="lm")
    save(img, "page-uninstall.bmp")


# ---------------------------------------------------------------- 进度页 banner
def instfiles_banner():
    w, h = PAGE_W, BANNER_H
    img = Image.new("RGB", (w * S, h * S), HERO_B)
    diag_grad(img, HERO_A, HERO_B, HERO_C)
    glow(img, 90, 0, 220, ACC, 0.26)
    d = ImageDraw.Draw(img)
    paste_logo(img, 22, 12, 30)
    text(d, (64, 22), "正在安装 Trim", FG, font(14.5, bold=True), anchor="lm")
    text(d, (64, 41), "正在复制应用文件并注册快捷方式，请稍候…", FG3, font(10.5))
    save(img, "instfiles-banner.bmp", (w, h))


# ---------------------------------------------------------------- 进度条轨道
def progress_track():
    w, h = PAGE_W, 14
    img = Image.new("RGB", (w * S, h * S), HERO_B)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w * S - 1, h * S - 1), radius=(h / 2) * S, fill=(28, 30, 48),
                        outline=(52, 55, 88), width=1 * S)
    save(img, "progress-track.bmp", (w, h))


# ---------------------------------------------------------------- 渐变按钮
def button(name, w, h, c1, c2, label, fg, border):
    img = Image.new("RGB", (w * S, h * S), c1)
    d = ImageDraw.Draw(img)
    for i in range(h * S):
        d.line([(0, i), (w * S, i)], fill=lerp(c1, c2, i / (h * S)))
    # 圆角遮罩 + 1px 描边 + 顶部高光
    mask = Image.new("L", (w * S, h * S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w * S - 1, h * S - 1), radius=10 * S, fill=255)
    out = Image.new("RGB", (w * S, h * S), HERO_C)
    out.paste(img, (0, 0), mask)
    d = ImageDraw.Draw(out)
    d.rounded_rectangle((0, 0, w * S - 1, h * S - 1), radius=10 * S, outline=border, width=1 * S)
    d.line([(10 * S, 1 * S), ((w - 10) * S, 1 * S)], fill=lerp(c1, (255, 255, 255), 0.35))
    d.text((w * S / 2, h * S / 2), label, fill=fg, font=font(12.5, bold=True), anchor="mm")
    save(out, name, (w, h))
    # 圆角外区域填安装器底色，避免 LoadImage 后露出黑角
    return out


def buttons():
    button("btn-primary.bmp", 110, 34, ACC_L, ACC, "安装", (23, 24, 50), (196, 198, 250))
    button("btn-primary-press.bmp", 110, 34, ACC, ACC_D, "安装", (16, 16, 26), (166, 169, 242))
    button("btn-primary-disabled.bmp", 110, 34, DISABLED_A, DISABLED_B, "安装", DISABLED_FG, (70, 73, 100))
    button("btn-secondary.bmp", 96, 34, (48, 50, 76), (38, 40, 62), "取消", FG2, (78, 81, 120))
    button("btn-browse.bmp", 110, 34, (52, 54, 84), (41, 43, 68), "浏览…", FG2, (86, 89, 130))
    button("btn-finish.bmp", 110, 34, ACC_L, ACC, "完成", (23, 24, 50), (196, 198, 250))
    button("btn-open.bmp", 110, 34, (48, 50, 76), (38, 40, 62), "打开目录", FG2, (78, 81, 120))


# ---------------------------------------------------------------- 勾选框
def checkboxes():
    size = 18
    for name, checked in (("check-on.bmp", True), ("check-off.bmp", False)):
        img = Image.new("RGB", (size * S, size * S), CARD)
        d = ImageDraw.Draw(img)
        if checked:
            for i in range(size * S):
                d.line([(0, i), (size * S, i)], fill=lerp(ACC_L, ACC_D, i / (size * S)))
            mask = Image.new("L", (size * S, size * S), 0)
            ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * S - 1, size * S - 1), radius=5 * S, fill=255)
            base = Image.new("RGB", (size * S, size * S), CARD)
            base.paste(img, (0, 0), mask)
            img = base
            d = ImageDraw.Draw(img)
            check_mark(d, size / 2, size / 2, r=6, color=(23, 24, 50), width=2)
        else:
            d.rounded_rectangle((0, 0, size * S - 1, size * S - 1), radius=5 * S, fill=(30, 31, 48),
                                outline=(96, 99, 140), width=1 * S)
        save(img, name, (size, size))


# ---------------------------------------------------------------- 跟随聚光贴图
def spotlight():
    """跟随聚光层：纯黑背景 + 薰衣草柔光（黑会被 LWA_COLORKEY 键掉 → 无缝跟随）。"""
    n = SPOT_SIZE
    img = Image.new("RGB", (n * S, n * S), (0, 0, 0))
    r = (n / 2) * S
    px = img.load()
    for y in range(n * S):
        dy = (y - r) / r
        for x in range(n * S):
            dx = (x - r) / r
            d2 = dx * dx + dy * dy
            if d2 >= 1.0:
                px[x, y] = (0, 0, 0)
                continue
            f = (1.0 - math.sqrt(d2)) ** 2 * 0.62
            val = (round(ACC[0] * f), round(ACC[1] * f), round(ACC[2] * f))
            px[x, y] = val if (val[0] + val[1] + val[2]) > 3 else (0, 0, 0)
    save(img, "spotlight.bmp", (n, n))


if __name__ == "__main__":
    page_setup()
    page_finish()
    page_uninstall()
    instfiles_banner()
    progress_track()
    buttons()
    checkboxes()
    spotlight()
    print("完成：build/installer/*.bmp")


