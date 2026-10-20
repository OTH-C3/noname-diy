#!/usr/bin/env python3
"""解开扩展压缩包，并自动定位扩展根目录。

用法：
    python3 unpack-extension.py <压缩包> [输出目录]
    （Windows 上把 python3 换成 python 或 py）

行为：
1. 解压到输出目录（默认：压缩包同级的 <包名>/ 文件夹）
2. 自动往下找 extension.js 所在的那一层，作为「扩展根」
   —— 社区包的 zip 常多套一层父文件夹，甚至套了两层
3. 打印扩展根路径与关键文件，供后续步骤使用

退出码：
    0  成功
    1  参数不对 / 找不到输入文件
    2  压缩包里没有 extension.js
    3  解压失败

为什么要单独做成脚本：
- `unzip` 不一定装；Python 内置 zipfile 跨平台可用
- 中文文件名在 zip 里可能用 GBK 编码，zipfile 默认按 UTF-8 解会乱码，这里做了兜底
- 「找 extension.js 在哪一层」这件事每次都要判断，写成脚本以免反复推理

能处理的：
- GBK / UTF-8 中文文件名
- 多套一层或两层父目录（自动定位扩展根）
- 带路径穿越的恶意条目（跳过并告警）
- 不是 zip 的文件（明确报错，而不是解出一堆垃圾）

不处理的（遇到就老实报错，别硬来）：
- 加密 zip（会抛 RuntimeError）
- 分卷 zip（只有一个分片时解不全）
- rar / 7z 改名成 .zip（报「不是有效的 zip」）

所以界面上写的是「推荐手动解压」—— 非常规压缩包先自己解开，再选文件夹。
"""

# 让类型注解延迟求值：这样 Python 3.7+ 都能跑。
# 否则 `Path | None` 要 3.10+、`list[str]` 要 3.9+。
from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path

MAX_DEPTH = 3  # 往下最多找几层


def fix_name(info: zipfile.ZipInfo) -> str:
    """zip 里的文件名可能是 GBK 编码（Windows 打包常见），这里做兜底。"""
    name = info.filename
    if info.flag_bits & 0x800:
        return name  # 明确标记为 UTF-8
    try:
        return name.encode("cp437").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


def safe_target(base: Path, rel: str) -> Path | None:
    """防路径穿越：只允许落在 base 里面。"""
    target = (base / rel).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        return None
    return target


def unpack(archive: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            rel = fix_name(info)
            if not rel or rel.endswith("/"):
                continue
            target = safe_target(out_dir, rel)
            if target is None:
                print(f"  [跳过] 疑似路径穿越：{rel}", file=sys.stderr)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(target, "wb") as dst:
                dst.write(src.read())


def find_root(base: Path, depth: int = 0) -> Path | None:
    """往下找 extension.js 所在的那一层。"""
    if (base / "extension.js").is_file():
        return base
    if depth >= MAX_DEPTH:
        return None
    try:
        children = [p for p in base.iterdir() if p.is_dir() and not p.name.startswith("__")]
    except OSError:
        return None
    for child in children:
        found = find_root(child, depth + 1)
        if found:
            return found
    return None


def describe(root: Path) -> None:
    """打印扩展根里的关键内容，方便确认解对了没有。"""
    print(f"  扩展根：{root}")
    for rel in ["extension.js", "info.json", "README.md"]:
        p = root / rel
        print(f"    {'[有]' if p.is_file() else '[无]'} {rel}")

    for sub in ["character/character.js", "character.js"]:
        if (root / sub).is_file():
            print(f"    [有] {sub}")

    imgs = [
        p.name
        for p in root.iterdir()
        if p.suffix.lower() in (".jpg", ".png", ".webp")
    ] if root.is_dir() else []
    if imgs:
        print(f"    根目录图片：{len(imgs)} 张（例：{', '.join(imgs[:3])}）")

    for d in ["character", "image", "audio"]:
        if (root / d).is_dir():
            n = sum(1 for _ in (root / d).rglob("*") if _.is_file())
            print(f"    [有] {d}/（{n} 个文件）")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1

    archive = Path(argv[1]).expanduser().resolve()
    if not archive.is_file():
        print(f"[错误] 找不到文件：{archive}", file=sys.stderr)
        return 1

    out_dir = (
        Path(argv[2]).expanduser().resolve()
        if len(argv) > 2
        else archive.parent / archive.stem
    )

    print(f"[1/3] 解压 {archive.name} → {out_dir}")
    try:
        unpack(archive, out_dir)
    except zipfile.BadZipFile:
        print("[错误] 这不是一个有效的 zip（可能其实是 rar/7z，需要先转换）", file=sys.stderr)
        return 3
    except OSError as e:
        print(f"[错误] 解压失败：{e}", file=sys.stderr)
        return 3

    print("[2/3] 定位扩展根")
    root = find_root(out_dir)
    if root is None:
        print(
            "[错误] 这个包里没找到 extension.js —— 确认它是不是扩展包"
            "（无名杀扩展必须有一个 extension.js，否则引擎会忽略整个文件夹）",
            file=sys.stderr,
        )
        return 2

    print("[3/3] 完成")
    describe(root)
    print()
    print(f"扩展根：{root}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))