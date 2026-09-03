# -*- coding: utf-8 -*-
"""修复 TuneForge 图标四角白点 v2：用严格阈值区分紫色主体与白色背景/柔和阴影。"""
from PIL import Image, ImageDraw, ImageFilter
import os

ROOT = r"c:\kaifa\TuneForge v1.2"
SRC = os.path.join(ROOT, "ico", "ico", "source.png")

img = Image.open(SRC).convert("RGBA")
W, H = img.size
px = img.load()

def is_body(p):
    """紫色主体（排除白背景与浅色阴影）：饱和度足够或亮度足够低"""
    r, g, b = p[0], p[1], p[2]
    return (max(r, g, b) - min(r, g, b) > 25) or (max(r, g, b) < 205)

# 1) 主体外接框（行/列内主体像素计数，抗单点噪声）
col_hits = [0] * W
row_hits = [0] * H
for y in range(0, H, 2):
    for x in range(0, W, 2):
        if is_body(px[x, y]):
            col_hits[x] += 1
            row_hits[y] += 1
xs = [x for x in range(W) if col_hits[x] >= 3]
ys = [y for y in range(H) if row_hits[y] >= 3]
left, right, top, bottom = min(xs), max(xs), min(ys), max(ys)
bw, bh = right - left + 1, bottom - top + 1
print(f"body bbox: ({left},{top})-({right},{bottom}) size={bw}x{bh}")

# 2) 圆角半径：主体顶行最左着色点
top_row_x = None
for x in range(left, right + 1):
    if is_body(px[x, top + 2]):
        top_row_x = x
        break
radius = (top_row_x - left) if top_row_x else int(min(bw, bh) * 0.22)
print(f"corner radius ≈ {radius}px ({radius/min(bw,bh)*100:.1f}%)")

# 3) 圆角矩形蒙版：缩 1px 吃掉白色 AA 边，再羽化
mask = Image.new("L", (W, H), 0)
d = ImageDraw.Draw(mask)
d.rounded_rectangle([left + 1, top + 1, right - 1, bottom - 1], radius=radius, fill=255)
mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.1))

# 4) 应用蒙版
r_, g_, b_, _ = img.split()
img = Image.merge("RGBA", (r_, g_, b_, mask))
print("corner alphas:", [img.getpixel(p)[3] for p in [(2, 2), (W - 3, 2), (2, H - 3), (W - 3, H - 3)]])

# 5) 输出
ico_dir = os.path.join(ROOT, "ico", "ico")
img.save(SRC)
for s in [12, 16, 24, 32, 48, 64, 96]:
    img.resize((s, s), Image.LANCZOS).save(os.path.join(ico_dir, f"icon_{s}x{s}.png"))

# ICO 以最大帧 256 为基底、小帧 append（PIL 只会从 >= 目标尺寸的帧缩小，
# 基底若是 16px 则只写入 16x16 一帧，导致桌面图标模糊且白角外露）
ico_sizes = [16, 24, 32, 48, 64, 96, 128, 256]
frames = [img.resize((s, s), Image.LANCZOS) for s in ico_sizes]
frames[-1].save(os.path.join(ico_dir, "TuneForge.ico"), format="ICO",
                append_images=frames[:-1])

inst_assets = os.path.join(ROOT, "tuneforge-installer", "src", "assets")
img.resize((192, 192), Image.LANCZOS).save(os.path.join(inst_assets, "tuneforge-192.png"))
img.resize((32, 32), Image.LANCZOS).save(os.path.join(inst_assets, "tuneforge-32.png"))

img.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, "tuneforge-installer", "src-tauri", "icons", "icon.ico"),
                                           format="ICO", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print("done v2")
