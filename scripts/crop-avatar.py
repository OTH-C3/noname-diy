#!/usr/bin/env python3
"""crop-avatar.py —— 把一张立绘原图裁成引擎要的 350×464。

**什么时候用它**：纯对话模式下，用户直接丢来一张立绘原图（1920×1080 那种），
需要裁成规格图。**走网页工坊的话不用它** —— 工坊右栏自带裁剪器，拖一拖就能导出。

规格：`350 × 464` 是社区通行规格（对齐官方 `image/character/*.jpg`），
引擎本身**不校验**尺寸（超了会拉伸或裁切），见 `references/无名杀规范.md` 第十六节。

依赖 Pillow（`pip install Pillow`）。没装也行 —— 改用网页工坊裁，那里不用装东西。

用法：
    python3 scripts/crop-avatar.py <原图> <输出.jpg> [--center 0.5,0.3] [--size 350x464]

  --center  裁切中心，用**相对比例** 0~1（默认 0.5,0.5 居中）。
            人像一般要往上提一点，试 0.5,0.35。
"""
import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("这个脚本要 Pillow 来读图裁图，先装一下：", file=sys.stderr)
    print("    pip install Pillow", file=sys.stderr)
    print("或者走网页工坊：右栏立绘区拖一拖就能导出 350×464，不用装东西。", file=sys.stderr)
    sys.exit(2)


def main():
    ap = argparse.ArgumentParser(description="把立绘裁成引擎规格（350×464）")
    ap.add_argument("src", help="原图")
    ap.add_argument("dst", help="输出的 jpg")
    ap.add_argument("--center", default="0.5,0.5", help="裁切中心（相对比例，默认居中）")
    ap.add_argument("--size", default="350x464", help="输出尺寸（默认 350x464）")
    args = ap.parse_args()

    try:
        cx, cy = [float(x) for x in args.center.split(",")]
    except Exception:
        sys.exit("--center 要写成 0.5,0.35 这样")
    try:
        w, h = [int(x) for x in args.size.lower().split("x")]
    except Exception:
        sys.exit("--size 要写成 350x464 这样")

    src = Path(args.src).expanduser()
    dst = Path(args.dst).expanduser()
    if not src.is_file():
        sys.exit(f"原图不存在：{src}")

    im = Image.open(src).convert("RGB")
    sw, sh = im.size

    # 按目标宽高比在原图上取尽量大的矩形，中心落在 (cx, cy)
    ratio = w / h
    if sw / sh > ratio:
        crop_h = sh
        crop_w = round(sh * ratio)
    else:
        crop_w = sw
        crop_h = round(sw / ratio)

    left = max(0, min(round(cx * sw - crop_w / 2), sw - crop_w))
    top = max(0, min(round(cy * sh - crop_h / 2), sh - crop_h))

    out = im.crop((left, top, left + crop_w, top + crop_h)).resize((w, h), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst, "JPEG", quality=92)

    print(f"已输出 {dst}")
    print(f"  原图 {sw}×{sh} → 裁 {crop_w}×{crop_h}（中心 {cx},{cy}）→ {w}×{h} JPEG")
    print("放进扩展根目录，文件名用角色 id：<角色id>.jpg")


if __name__ == "__main__":
    main()
