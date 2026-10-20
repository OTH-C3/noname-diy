#!/usr/bin/env python3
"""install-to-game.py —— 把工作区里做好的扩展同步进游戏本体。

**为什么必须有这一步**：游戏真正加载的是 `<游戏>/resources/app/extension/<扩展名>/`。
你在工作区改的那份再正确，没同步过去，游戏里看到的还是旧版 ——
反馈里那位第一轮做了无用功（「改了没效果」其实只是没装机）。

两条已发生过的问题：
  · 备份**不能**放进 `extension/` 里面：游戏会把该目录下每个子目录都当成一个扩展扫出来，
    备份会被识别成一个「扩展」，扩展列表里凭空多出一堆垃圾 → 放同级的 `extension-backup/`。
  · 覆盖失败（文件被占用、权限不够）往往不报错，所以装完**必须逐个比 sha256**。

用法：
    python3 scripts/install-to-game.py <扩展目录> <游戏根> [--dry-run]

  <扩展目录>：含 extension.js 的那一层
  <游戏根>  ：含 resources/app/ 的目录；给它的上层也行，脚本会往下找

例：
    python3 scripts/install-to-game.py ../扩展源码/北北的辰 /d/无名杀
"""
import argparse
import hashlib
import json
import re
import shutil
import sys
import time
from pathlib import Path


def die(msg):
    print("错误：" + msg, file=sys.stderr)
    sys.exit(1)


def read_ext_name(ext_dir):
    """扩展名以 extension.js 的 name 为准 —— 游戏是按它去找文件夹的。"""
    f = ext_dir / "extension.js"
    if not f.is_file():
        die(f"`{ext_dir}` 里没有 extension.js，这不像一个扩展目录")
    text = f.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"name\s*:\s*[\"']([^\"']+)[\"']", text)
    if m:
        return m.group(1)
    info = ext_dir / "info.json"
    if info.is_file():
        try:
            return json.loads(info.read_text(encoding="utf-8")).get("name") or ext_dir.name
        except Exception:
            pass
    return ext_dir.name


def find_extension_dir(game_root):
    """在游戏根下找 extension/ 目录。"""
    for c in (
        game_root / "resources" / "app" / "extension",
        game_root / "app" / "extension",
        game_root / "extension",
    ):
        if c.is_dir():
            return c
    # 有的整合包外面还套着一层目录，浅扫三层
    for depth in (1, 2, 3):
        for p in game_root.glob("/".join(["*"] * depth) + "/resources/app/extension"):
            if p.is_dir():
                return p
    return None


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description="把扩展同步进游戏本体")
    ap.add_argument("extension", help="扩展目录（含 extension.js 的那一层）")
    ap.add_argument("game", help="游戏根目录（含 resources/app/）")
    ap.add_argument("--dry-run", action="store_true", help="只显示要做什么，不动文件")
    args = ap.parse_args()

    ext_dir = Path(args.extension).expanduser().resolve()
    if not ext_dir.is_dir():
        die(f"扩展目录不存在：{ext_dir}")
    game_root = Path(args.game).expanduser().resolve()
    if not game_root.is_dir():
        die(f"游戏根目录不存在：{game_root}")

    ext_name = read_ext_name(ext_dir)
    container = find_extension_dir(game_root)
    if not container:
        die(f"在 {game_root} 下找不到 extension/ 目录 —— 游戏根给对了吗？")
    target = container / ext_name

    print(f"扩展名（取自 extension.js）：{ext_name}")
    if ext_dir.name != ext_name:
        print(f"注意：目录名叫 `{ext_dir.name}`，与扩展名不一致 —— 装机按扩展名放，之后两边目录名会不同")
    print(f"目标：{target}")

    files = [p for p in sorted(ext_dir.rglob("*")) if p.is_file()]
    print(f"待同步：{len(files)} 个文件\n")

    if args.dry_run:
        backup = container.parent / "extension-backup" / f"{ext_name}-<时间戳>"
        print(f"（dry-run）已有版本会先备份到 {backup}")
        for p in files:
            print("   ", p.relative_to(ext_dir))
        return

    if target.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = container.parent / "extension-backup" / f"{ext_name}-{stamp}"
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(target, backup)
        print(f"已备份旧版 → {backup}")

    target.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ext_dir, target, dirs_exist_ok=True)

    # 逐个比 sha256 —— 覆盖失败基本不报错，只能自己验
    bad = []
    for p in files:
        dst = target / p.relative_to(ext_dir)
        if not dst.exists() or sha256(p) != sha256(dst):
            bad.append(str(p.relative_to(ext_dir)))

    print()
    if bad:
        print(f"校验没过（{len(bad)} 个文件）：覆盖没成功？游戏还开着占用文件？")
        for b in bad:
            print("   ", b)
        sys.exit(1)

    print(f"装机完成：{len(files)} 个文件逐个 sha256 校验一致")
    print("接下来去游戏「扩展」页看一眼（首次装要在那里手动启用）。")
    print("提示：这是覆盖式同步，旧版里多出来的文件不会自动删 —— 需要干净重装就先删目标目录。")


if __name__ == "__main__":
    main()
