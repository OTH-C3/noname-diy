#!/usr/bin/env python3
"""update-skill.py —— 用新版本的 zip 更新已装好的 skill，并保住版本经验里的「本机增量」。

**为什么需要它**：skill 更新是「新 zip 整包覆盖」。而 `references/version-notes/*.md` 既是
随包基线（跟游戏版本走）、又是本机积累引擎经验的唯一落点（跟自己的机器走）——
直接覆盖会把积累一起冲掉。所以更新走本脚本：**覆盖包内文件、合并本机增量、不动包外文件**。

它做四件事：
  1. 备份现有 skill 目录（默认 `<skill目录>/../.skill-backups/<名字>-<时间戳>/`）
  2. 解压新 zip，定位 skill 根（含 SKILL.md 的那层）
  3. 包内文件逐个覆盖过去 —— **不删**包外文件（`.git`、你自己加的东西都留着）
  4. 把旧版 `references/version-notes/*.md` 里「## 本机增量」小节的内容合并进新版同名小节
     （按行去重，只追加新版没有的条目）

用法：
    python3 scripts/update-skill.py <新版本.zip> [--skill-dir <已装的skill目录>] [--dry-run]

  --skill-dir  省略时取本脚本所在目录的上一级（即 skill 根）
  --dry-run    只说要做啥，不落盘

注意：
  · 包外文件（含 `.git`）**不会被删**；用 git 维护 skill 的场合，更新后照常 `git status` 看差异
  · 旧版有、新版没有的文件**不会**被删，但会列在报告里，自己决定留不留
  · 合并以「## 本机增量」小节为单位：新版基线内容照常换新，本机积累追加保留
"""

import argparse
import os
import shutil
import sys
import tempfile
import time
import zipfile

MARKER = "## 本机增量"
BACKUP_DIR_NAME = ".skill-backups"


def find_skill_root(base):
    """在解压出来的目录里找含 SKILL.md 的那一层。"""
    if os.path.isfile(os.path.join(base, "SKILL.md")):
        return base
    for name in sorted(os.listdir(base)):
        p = os.path.join(base, name)
        if os.path.isdir(p) and os.path.isfile(os.path.join(p, "SKILL.md")):
            return p
    raise SystemExit("新包里没找到 SKILL.md，无法定位 skill 根（是不是拿错 zip 了？）")


def read_section(text):
    """取出「## 本机增量」小节的正文行（不含标题），到下一个二级标题为止。"""
    lines = text.splitlines()
    out, inside = [], False
    for ln in lines:
        if ln.startswith("## "):
            inside = ln.strip() == MARKER
            continue
        if inside:
            out.append(ln)
    return out


def merge_section(new_text, old_lines):
    """把旧的本机增量条目并进新版文本；返回 (新文本, 追加条数)。"""
    want = [ln for ln in old_lines if ln.strip()]
    if not want:
        return new_text, 0

    lines = new_text.splitlines()
    at = next((i for i, ln in enumerate(lines) if ln.strip() == MARKER), None)

    if at is None:
        body = [""] + [MARKER, ""] + want
        joined = "\n".join(lines + body)
        return joined + "\n", len(want)

    end = len(lines)
    for j in range(at + 1, len(lines)):
        if lines[j].startswith("## "):
            end = j
            break

    have = {ln.strip() for ln in lines[at + 1 : end] if ln.strip()}
    add = [ln for ln in want if ln.strip() not in have]
    if not add:
        return new_text, 0

    merged = lines[:end] + add + lines[end:]
    return "\n".join(merged) + "\n", len(add)


def main():
    ap = argparse.ArgumentParser(description="更新已装的 skill，并保住版本经验里的本机增量")
    ap.add_argument("zip_path", help="新版本的 skill zip")
    ap.add_argument("--skill-dir", help="已装好的 skill 目录（默认为本脚本上一级）")
    ap.add_argument("--dry-run", action="store_true", help="只报告，不落盘")
    ap.add_argument(
        "--work-dir",
        help="解压用的临时目录（默认：当前目录下的 .skill-update-tmp/）。"
        "沙箱环境里系统 temp 常常不可写（PermissionError WinError 5），这时把它指到工作区",
    )
    args = ap.parse_args()

    skill_dir = os.path.abspath(
        args.skill_dir or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    )
    if not os.path.isfile(os.path.join(skill_dir, "SKILL.md")):
        raise SystemExit("这个目录不像 skill 根（没有 SKILL.md）：" + skill_dir)
    if not os.path.isfile(args.zip_path):
        raise SystemExit("找不到这个 zip：" + args.zip_path)

    # 先把旧的本机增量收好 —— 覆盖之后就没机会了
    vn_dir = os.path.join(skill_dir, "references", "version-notes")
    old_inc = {}
    if os.path.isdir(vn_dir):
        for name in sorted(os.listdir(vn_dir)):
            if not name.endswith(".md"):
                continue
            with open(os.path.join(vn_dir, name), encoding="utf-8") as fh:
                section = read_section(fh.read())
            if any(ln.strip() for ln in section):
                old_inc[name] = section

    # 解压目录：优先 --work-dir，默认当前目录下的 .skill-update-tmp/。
    #
    # ⚠️ 有些环境的沙箱**会禁止 Python 建目录**：DSH 上实测，即使把目录指到工作区
    # （D:\...）仍然报 `PermissionError: [WinError 5] 拒绝访问`，要申请一次文件权限
    # 才能跑通。**这不是路径选得不对，脚本绕不过去** —— 换任何目录都会被拒。
    # 两条出路：
    #   ① 给这次操作文件权限（DSH 里叫 danger-full-access）；
    #   ② 自己把 zip 解压到 skill 旁边、手工覆盖（代价：丢掉「本机增量」的合并，
    #      那条命令是 `--skill-dir` 指过去之前的退路，得自己先备份）。
    work_root = args.work_dir or os.path.join(os.getcwd(), ".skill-update-tmp")
    try:
        os.makedirs(work_root, exist_ok=True)
    except OSError as exc:
        sys.exit(
            f"建不出解压目录（{work_root}）：{exc}\n"
            "  这多半是**沙箱禁止写盘**，不是路径问题 —— 换目录也会一样。两条出路：\n"
            "   ① 给这次操作文件权限（DSH 里是 danger-full-access）；\n"
            "   ② 用 --work-dir 指一个**已经存在**、且你确认可写的目录。"
        )
    # 少建一层目录：mkdtemp 会再 mkdir 一次，沙箱里每建一次都可能被拒
    tmp = os.path.join(work_root, "_extract")
    if not os.path.isdir(tmp):
        os.makedirs(tmp, exist_ok=True)
    try:
        with zipfile.ZipFile(args.zip_path) as z:
            z.extractall(tmp)
        new_root = find_skill_root(tmp)

        # 备份（放在 skill 目录的**外面**，免得被当成 skill 的一部分/被下次更新卷进去）
        backup = None
        if not args.dry_run:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            backup = os.path.join(
                os.path.dirname(skill_dir),
                BACKUP_DIR_NAME,
                os.path.basename(skill_dir) + "-" + stamp,
            )
            shutil.copytree(skill_dir, backup, symlinks=True)

        # 覆盖包内文件（不删包外的东西）
        copied = set()
        for dirpath, _, files in os.walk(new_root):
            for name in files:
                src = os.path.join(dirpath, name)
                rel = os.path.relpath(src, new_root)
                copied.add(rel)
                if args.dry_run:
                    continue
                dst = os.path.join(skill_dir, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copy2(src, dst)

        # 合并本机增量
        merged = []
        for name, lines in old_inc.items():
            dst = os.path.join(vn_dir, name)
            if os.path.isfile(dst):
                with open(dst, encoding="utf-8") as fh:
                    text = fh.read()
            else:
                text = "# 无名杀版本经验\n"
            new_text, added = merge_section(text, lines)
            if added and not args.dry_run:
                os.makedirs(vn_dir, exist_ok=True)
                with open(dst, "w", encoding="utf-8") as fh:
                    fh.write(new_text)
            merged.append((name, added))

        # 旧版有、新版没有的文件（不删，只提示）
        skip_dirs = {".git", BACKUP_DIR_NAME, "__pycache__"}
        leftover = []
        for dirpath, dirs, files in os.walk(skill_dir):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            for name in files:
                rel = os.path.relpath(os.path.join(dirpath, name), skill_dir)
                if rel not in copied:
                    leftover.append(rel)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(("【试运行】" if args.dry_run else "") + "skill 目录：" + skill_dir)
    if backup:
        print("备份：" + backup)
    print("包内文件：" + str(len(copied)) + " 个" + ("（未落盘）" if args.dry_run else "（已覆盖）"))
    if merged:
        for name, added in merged:
            print("本机增量：" + name + " 追加 " + str(added) + " 行" + ("（未落盘）" if args.dry_run else ""))
    else:
        print("本机增量：无（旧版没有条目，或文件不存在）")
    if leftover:
        print("包外未覆盖的 " + str(len(leftover)) + " 个文件（不会被删，自己看着办）：")
        for rel in leftover[:20]:
            print("  · " + rel)
        if len(leftover) > 20:
            print("  · ……还有 " + str(len(leftover) - 20) + " 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
