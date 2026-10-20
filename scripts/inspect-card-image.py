#!/usr/bin/env python3
"""inspect-card-image.py —— 把卡面切成几块、放大，方便看清上面的字。

**什么时候用它**：用户直接在对话里发来一张卡面图（没走网页工坊）时，你要先看清上面写了什么。
原图里那些竖排小字只有二十来像素高，直接看很容易认错 —— 裁出来放大 3 倍就清楚多了。

切块坐标是按一批真实卡面量出来的（版式基本一致）：势力字在左上、勾玉在顶部一排、
称号与名字竖排在左侧、技能在下部。**但不是所有卡面都长这样**，
裁完要回看整图核对一下位置关系，不要以裁块为唯一依据。

用法：
    python3 scripts/inspect-card-image.py <卡面图> [--out 输出目录]

产出（默认写到 <卡面图所在目录>/card-parts/）：
    整图.jpg                                        长边缩到 1400
    part-group.jpg / part-pips.jpg / part-name.jpg / part-skill.jpg   各放大 3 倍

与网页工坊的关系：工坊的「识别卡面」在前端做了同样的切块（`workshop/scripts/main.js`
里的 `CI_BOXES`）。走工坊时用不到这个脚本。

依赖 Pillow（`pip install Pillow`）。
"""
import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("这个脚本要 Pillow 来读图裁图，先装一下：", file=sys.stderr)
    print("    pip install Pillow", file=sys.stderr)
    sys.exit(2)

# 与前端 CI_BOXES 保持一致（归一化坐标）
BOXES = {
    "group": (0.00, 0.00, 0.20, 0.15),
    "pips": (0.14, 0.00, 0.62, 0.10),
    "name": (0.00, 0.05, 0.26, 0.94),
    "skill": (0.02, 0.50, 0.99, 0.98),
}
SCALE = 3
MAX_SIDE = 1400


def main():
    ap = argparse.ArgumentParser(description="把卡面切块放大，方便认字")
    ap.add_argument("card", help="卡面图")
    ap.add_argument("--out", help="输出目录（默认 <卡面图目录>/card-parts/）")
    args = ap.parse_args()

    src = Path(args.card).expanduser()
    if not src.is_file():
        sys.exit(f"卡面图不存在：{src}")
    out = Path(args.out).expanduser() if args.out else src.parent / "card-parts"
    out.mkdir(parents=True, exist_ok=True)

    im = Image.open(src).convert("RGB")
    w, h = im.size

    whole = im.copy()
    whole.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    whole.save(out / "整图.jpg", "JPEG", quality=92)

    lines = [f"原图 {w}×{h} → {out}"]
    for tag, (x0, y0, x1, y1) in BOXES.items():
        c = im.crop((round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h)))
        c = c.resize((c.width * SCALE, c.height * SCALE), Image.LANCZOS)
        name = f"part-{tag}.jpg"
        c.save(out / name, "JPEG", quality=92)
        lines.append(f"  {name}  {c.width}×{c.height}")

    for ln in lines:
        print(ln)
    print()
    print("看的时候按这个顺序：先看放大过的 part-*，再回看 整图.jpg 核对位置关系。")
    print("要认的东西：势力字（认字，别靠配色）、勾玉总数（= 体力上限，实心 = 当前体力）、")
    print("左侧竖排（称号在上、名字在下）、下部技能名与描述。")


if __name__ == "__main__":
    main()
