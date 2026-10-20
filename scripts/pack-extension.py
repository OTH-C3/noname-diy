#!/usr/bin/env python3
"""
无名杀扩展打包：把扩展目录打成可直接导入游戏的 zip。

关键约束（已发生过的问题）：
  zip 根目录必须【直接】是 extension.js，不能多套一层文件夹，
  否则游戏的「导入扩展」认不出来。

用法：
  python3 pack-extension.py <扩展目录> [输出 zip 路径]
  （Windows 上把 python3 换成 python 或 py）

退出码：
  0  成功（且结构自检通过）
  1  打包成功但结构可疑（extension.js 不在根目录）
  2  参数/路径错误
"""

# 让类型注解延迟求值：这样 Python 3.7+ 都能跑。
# 否则 `Path | None` 要 3.10+、`list[str]` 要 3.9+。
from __future__ import annotations

import os
import sys
import zipfile


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    src = os.path.abspath(sys.argv[1].rstrip("/"))
    if not os.path.isdir(src):
        print(f"[错误] 不是目录：{src}")
        return 2

    name = os.path.basename(src)
    dst = sys.argv[2] if len(sys.argv) > 2 else f"{name}.zip"

    # 必备文件自检：缺了这两个游戏根本加载不了
    required = ("extension.js", "info.json")
    missing = [f for f in required if not os.path.isfile(os.path.join(src, f))]
    if missing:
        print(f"[错误] 缺必备文件：{', '.join(missing)}")
        return 2

    # 扩展名一致性（文件夹名 == extension.js 的 name）由 check-extension.mjs 负责，
    # 这里只保证打包本身不出错。
    files = []
    for root, _dirs, names in os.walk(src):
        for n in names:
            p = os.path.join(root, n)
            files.append((p, os.path.relpath(p, src)))

    if not files:
        print("[错误] 目录是空的")
        return 2

    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        for p, rel in sorted(files):
            z.write(p, rel)

    size_kb = os.path.getsize(dst) / 1024
    print(f"[通过] 导出到：{dst}")
    print(f"        {size_kb:.1f} KB，{len(files)} 个文件")
    print(f"源目录：{src}")
    print()
    print("把上面这个路径告诉用户 —— 只说文件名的话，工作区一深他就找不到了。")
    print("包内结构：")
    for _p, rel in sorted(files, key=lambda x: x[1]):
        print(f"  {rel}")

    if not any(rel == "extension.js" for _p, rel in files):
        print("[警告]  extension.js 不在 zip 根目录 —— 游戏可能认不出这个包")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())