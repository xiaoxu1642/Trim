# -*- coding: utf-8 -*-
"""Trim 图标生成器 v3：由 source.png 生成全套 PNG + ICO（含小尺寸圆角修正）。

v3（2026-09-14，图标替换批次）重写要点：
  1) 素材形态变更：新 source.png 的圆角面即整张画布（四角为白色切角），
     不再需要 v2 的「按主体包围盒裁切」——裁切对全画布圆角图会让包围盒判定漂移。
  2) 每个尺寸独立应用圆角蒙版：直接下采样会把 2px 级圆角平均掉，小尺寸四角残留白点
     （实测 16px 角 alpha≈50、12px 更高）。改为「先缩放、再按目标尺寸圆角半径重新蒙版」。
  3) <=16px 不羽化：蒙版羽化会把邻近不透明像素的 alpha 溢到角点，白角复现；
     2px 圆角下硬边无可见锯齿。
  4) 手工组装 ICO：PIL 的 ICO 保存会漏帧（实测 8 帧写入后只剩 7 帧、丢 96x96），
     改为按 ICO 格式显式写入全部帧（PNG 压缩帧，Vista+ 支持）。

用法：py -3.13 scripts/fix_icons.py（需要 Pillow）
"""
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import io
import os
import shutil
import struct

# 脚本位于 scripts/ 下，仓库根取自身位置的上一级（源码换位置后仍可运行）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICO_DIR = os.path.join(ROOT, "src", "assets", "ico")
SRC = os.path.join(ICO_DIR, "source.png")
SQUARED = os.path.join(ICO_DIR, "source_squared.png")

PNG_SIZES = [12, 16, 24, 32, 48, 64, 96]
ICO_SIZES = [16, 24, 32, 48, 64, 96, 128, 256]


def measure_radius(img):
    """圆角半径：沿主对角线找首个不透明点，d = r * (1 - 1/√2) ≈ 0.2929 r"""
    W, H = img.size
    px = img.load()
    d = next((i for i in range(min(W, H)) if px[i, i][3] > 8), None)
    return round(d / 0.2929) if d else int(min(W, H) * 0.15)


def frame(src, size, r_src):
    """单尺寸成品：缩放 + 按目标尺寸圆角半径蒙版（<=16px 不羽化，防白角溢出）"""
    im = src.resize((size, size), Image.LANCZOS)
    r = max(2, round(r_src * size / src.size[0]))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    if size > 16:
        mask = mask.filter(ImageFilter.GaussianBlur(0.5))
    im.putalpha(ImageChops.darker(im.getchannel("A"), mask))
    return im


def main():
    # 素材：优先用已裁切成品；缺失时由 source.png 生成（全画布圆角蒙版，缩 1px 吃白 AA 边）
    if os.path.exists(SQUARED):
        src = Image.open(SQUARED).convert("RGBA")
    else:
        src = Image.open(SRC).convert("RGBA")
        W, H = src.size
        r = measure_radius(src)
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).rounded_rectangle([1, 1, W - 2, H - 2], radius=r, fill=255)
        mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.1))
        src.putalpha(ImageChops.darker(src.getchannel("A"), mask))
        src.save(SQUARED)

    r_src = measure_radius(src)
    print(f"source {src.size[0]}x{src.size[1]}, corner radius ≈ {r_src}px ({r_src / src.size[0] * 100:.1f}%)")

    for s in PNG_SIZES:
        frame(src, s, r_src).save(os.path.join(ICO_DIR, f"icon_{s}x{s}.png"))
    print("PNG 已生成:", ", ".join(f"{s}x{s}" for s in PNG_SIZES))

    # ICO：手工组装，保证帧完整
    blobs = []
    for s in ICO_SIZES:
        b = io.BytesIO()
        frame(src, s, r_src).save(b, format="PNG", optimize=True)
        blobs.append(b.getvalue())
    header = struct.pack("<HHH", 0, 1, len(ICO_SIZES))
    offset = 6 + 16 * len(ICO_SIZES)
    entries = b""
    for s, data in zip(ICO_SIZES, blobs):
        dim = 0 if s >= 256 else s  # ICO 中 256 以 0 表示
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    ico_path = os.path.join(ICO_DIR, "Trim.ico")
    with open(ico_path, "wb") as f:
        f.write(header + entries + b"".join(blobs))
    print("ICO 已生成:", ico_path, len(ICO_SIZES), "帧")

    # 构建器（Tauri 安装器工程）可能位于本仓库内或同级的独立目录，按候选顺序解析。
    # 找不到时只跳过并提示，绝不凭空创建 trim-installer 幽灵目录。
    BUILDER_CANDIDATES = [
        os.path.join(ROOT, "trim-installer"),
        os.path.join(os.path.dirname(ROOT), "Trim goujian", "trim-installer"),
    ]
    builder = next((p for p in BUILDER_CANDIDATES if os.path.isdir(p)), None)
    if builder is None:
        print("WARN: 未找到 trim-installer 构建器目录，跳过构建器图标同步")
    else:
        inst_assets = os.path.join(builder, "src", "assets")
        os.makedirs(inst_assets, exist_ok=True)
        frame(src, 192, r_src).save(os.path.join(inst_assets, "trim-192.png"))
        frame(src, 32, r_src).save(os.path.join(inst_assets, "trim-32.png"))
        # Tauri 图标必须与 src/assets/ico/Trim.ico 逐字节一致：就地重采样会丢帧、
        # 产生与 Electron 端不同的图标位图，因此直接复制成品 ico。
        dst_ico = os.path.join(builder, "src-tauri", "icons", "icon.ico")
        os.makedirs(os.path.dirname(dst_ico), exist_ok=True)
        shutil.copyfile(ico_path, dst_ico)
        print("builder synced ->", builder)


if __name__ == "__main__":
    main()
