#!/usr/bin/env python3
"""place-assets.py —— 把工坊网页交上来的素材改名归位到扩展目录。

**为什么必须是脚本**：引擎对素材文件名是**写死**的，写错不会报任何错 ——
立绘不显示、配音不响，看起来就是「加了没效果」：

  · 立绘必须是 `<扩展目录>/<角色id>.jpg`（路径规则见规范 十六）
  · 技能配音必须是 `<扩展目录>/audio/<技能id>1.mp3`、`<技能id>2.mp3`，
    序号与技能 `audio` 字段的数字对应（`docs/audio-guide.md`）
  · 皮肤图必须是 `<扩展目录>/skin/<角色id>/<形态名>.jpg`，
    **形态名就是玩家在游戏里看到的皮肤名**（引擎取文件名去扩展名当标题，
    角色上还要写 `skinPath`，见下方收尾提醒）

而从网页下来的文件名是完全另一套：
`avatar-submitted.jpg`、`audio/霜刃配音-mv22mnokg.mp3` ——
技能名是中文、id 是英文，**手工改名极易出错，错了还没有任何提示**。

用法（在工作区里跑；工作区 = 有 `.diy-workshop/` 的那层）：

    # 最常用：给技能 id 映射，剩下的它自己从工坊产物里读
    python3 scripts/place-assets.py <扩展目录> --char cs_guotu \\
        --skill "霜刃=cs_shuangren" --skill "文伐=cs_wenfa"

    # 只看它要做什么，不动文件
    python3 scripts/place-assets.py <扩展目录> --char cs_guotu --skill "霜刃=cs_shuangren" --dry-run

    # 工作区不在当前目录时
    python3 scripts/place-assets.py <扩展目录> --workspace /path/to/工作区 --char cs_guotu ...

选项：
  --char <角色id>       立绘的目标文件名（不给就跳过立绘）
  --skill "技能名=技能id"  可重复。技能名按工坊里填的原样写，技能 id 是你生成的
  --workspace <目录>    默认当前目录
  --dry-run             只打印要做什么
  --move                复制后删掉源文件（默认保留）
  --force               扩展目录里没有 extension.js 也照做

退出码：0 完成 / 1 有素材没落地（缺映射之类） / 2 参数或前置不满足。
"""

import argparse
import json
import os
import re
import shutil
import sys

# 引擎默认去扩展目录根找 `<角色id>.jpg`；若不是 jpg，得在角色定义里写 img 字段
AVATAR_EXT = ".jpg"


def main():
    ap = argparse.ArgumentParser(description="把工坊交上来的素材改名归位到扩展目录")
    ap.add_argument("ext_dir", help="扩展目录（也就是 extension/<扩展名>/）")
    ap.add_argument("--char", default="", help="角色 id，立绘目标名")
    ap.add_argument("--skill", action="append", default=[],
                    help='技能名=技能id，可重复。例：--skill "霜刃=cs_shuangren"')
    ap.add_argument("--workspace", default=".", help="工作区，默认当前目录")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--move", action="store_true", help="复制后删源（默认保留）")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    ext_dir = os.path.abspath(args.ext_dir)
    if not os.path.isdir(ext_dir):
        print(f"[失败] 扩展目录不存在：{ext_dir}", file=sys.stderr)
        return 2
    if not os.path.exists(os.path.join(ext_dir, "extension.js")) and not args.force:
        print(f"[失败] {ext_dir} 不像扩展目录（里面没有 extension.js）。", file=sys.stderr)
        print("       确实要往这儿放，加 --force。", file=sys.stderr)
        return 2

    req_path = os.path.join(os.path.abspath(args.workspace), ".diy-workshop", "latest-request.json")
    if not os.path.exists(req_path):
        print(f"[失败] 读不到工坊的提交文件：{req_path}", file=sys.stderr)
        print("       先在网页工坊点「提交给 AI」。", file=sys.stderr)
        return 2
    with open(req_path, encoding="utf-8") as f:
        form = json.load(f)

    # 技能名 -> 技能 id
    skill_ids = {}
    for pair in args.skill:
        if "=" not in pair:
            print(f'[失败] --skill 的格式是 "技能名=技能id"，收到的是：{pair}', file=sys.stderr)
            return 2
        name, sid = pair.split("=", 1)
        skill_ids[name.strip()] = sid.strip()

    print(f"扩展目录：{ext_dir}")
    print(f"工坊提交：{req_path}")
    print(f"模式：{'只看不做（dry-run）' if args.dry_run else ('移动' if args.move else '复制')}")
    print()

    missing = 0

    def place(src, dst, note):
        """把 src 放到 dst。返回 (是否落地, 结果描述)"""
        nonlocal missing
        if not os.path.isfile(src):
            print(f"  跳过（源文件不在）：{src}")
            missing += 1
            return
        rel = os.path.relpath(dst, ext_dir)
        size = os.path.getsize(src)
        if args.dry_run:
            print(f"  {note}  →  {rel}  ({size // 1024} KB)")
            return
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if args.move:
            shutil.move(src, dst)
        else:
            shutil.copy2(src, dst)
        print(f"  {note}  →  {rel}  ({size // 1024} KB)")

    # ── 立绘 ──────────────────────────────────────────────────────────
    print("立绘")
    avatar = form.get("avatarPath")
    if not avatar:
        print("  这次没传立绘（网页里那步可以跳过，不影响玩）")
    elif not args.char:
        print("  [缺失] 有立绘但没给 --char（角色 id）—— 立绘必须叫 <角色id>.jpg，"
              "否则引擎找不到")
        missing += 1
    else:
        src_ext = os.path.splitext(avatar)[1].lower()
        dst = os.path.join(ext_dir, args.char + AVATAR_EXT)
        place(avatar, dst, os.path.basename(avatar))
        if src_ext and src_ext != AVATAR_EXT:
            print(f"    注意：源是 {src_ext}，但引擎默认只找 {AVATAR_EXT} ——"
                  f"要么先转成 jpg，要么在角色定义里写 img 字段指明路径。")

    # ── 配音 ──────────────────────────────────────────────────────────
    print()
    print("配音")
    any_audio = False
    for skill in form.get("skills", []):
        files = skill.get("audioFiles") or []
        if not files:
            continue
        any_audio = True
        name = skill.get("name") or "(未命名技能)"
        sid = skill_ids.get(name)
        if not sid:
            print(f"  [缺失] 技能「{name}」有 {len(files)} 个配音，但没给它的 --skill 映射 ——"
                  f"落不了地（文件名必须是 <技能id>n.mp3）")
            missing += len(files)
            continue
        for i, src in enumerate(files, 1):
            ext = os.path.splitext(src)[1].lower() or ".mp3"
            dst = os.path.join(ext_dir, "audio", f"{sid}{i}{ext}")
            place(src, dst, f"{name} 第 {i} 句  ←  {os.path.basename(src)}")
            if ext != ".mp3":
                print(f"    注意：源是 {ext}。引擎默认按 .mp3 找同名文件，"
                      f"非 mp3 要在技能的 audio 里写明后缀（见 reference 规范 8.1）。")
    if not any_audio:
        print("  这次没传配音")

    # ── 皮肤形态 ────────────────────────────────────────────────────────
    # 路线 A「玩家自选皮肤」：图放进 skin/<角色id>/，角色上写一行 skinPath。
    # 不碰技能代码；什么时候换形态（路线 B）是另一回事，由 AI 在对话里跟用户对。
    print()
    print("皮肤形态")
    skins = form.get("skins") or []
    any_skin = False
    for skin in skins:
        src = skin.get("path")
        name = str(skin.get("name") or "").strip()
        if not src:
            continue
        any_skin = True
        if not args.char:
            print("  [缺失] 有皮肤图但没给 --char（角色 id）—— 目标目录 skin/<角色id>/ 定不了")
            missing += 1
            continue
        if not name:
            print(f"  [缺失] 有一张皮肤图没写形态名（{os.path.basename(src)}）——"
                  f"形态名就是玩家看到的皮肤名，不能空")
            missing += 1
            continue
        # 形态名最终是文件名，文件系统不收的字符换掉（中文原样保留）
        safe_name = re.sub(r'[\\/:*?"<>|#%]', "_", name).strip() or "skin"
        if safe_name != name:
            print(f"    注意：形态名「{name}」含文件系统不收的字符，落盘用「{safe_name}」")
        ext = os.path.splitext(src)[1].lower() or ".jpg"
        dst = os.path.join(ext_dir, "skin", args.char, safe_name + ext)
        place(src, dst, f"皮肤「{safe_name}」  ←  {os.path.basename(src)}")
        # 引擎的「更改皮肤」界面用 文件名.slice(0, -4) 取标题 —— 后缀必须 4 个字符，
        # .jpeg（4 字符以上）会把标题截错
        if ext not in (".jpg", ".png", ".webp"):
            print(f"    注意：源是 {ext}。界面按『文件名去掉最后 4 个字符』取皮肤名，"
                  f"后缀请用 .jpg / .png。")
    if not any_skin:
        print("  这次没传皮肤图")

    # ── 收尾 ──────────────────────────────────────────────────────────
    print()
    if any_audio:
        # 配音要生效，技能上的 audio 字段得跟文件数对上
        for skill in form.get("skills", []):
            n = len(skill.get("audioFiles") or [])
            name = skill.get("name") or "(未命名技能)"
            if n and skill_ids.get(name):
                sid = skill_ids[name]
                print(f"  提醒：技能 {sid} 上有 {n} 个配音文件，"
                      f"技能定义要写 audio: \"ext:<扩展名>/audio:{n}\"（路径与数字之间是 : 不是 /）")

    if any_skin:
        # skinPath 不能省：引擎默认从立绘路径推导皮肤目录（去掉末两级 + /skin/<id>/），
        # 而我们的立绘在扩展根目录，推导会漏掉扩展名，一张皮肤都扫不到
        # （引擎默认从立绘路径推导皮肤目录，只有 pictures/ 子目录那种布局才推得对）。
        if args.char:
            print(f"  提醒：角色定义要写 skinPath: \"ext:<扩展名>/skin/{args.char}/\"，"
                  f"这行不能省 —— 立绘在扩展根目录时引擎自动推导会算错，"
                  f"不写的话游戏里一张皮肤都看不到。")
        die = form.get("dieLines") or []
        if die:
            print(f"  提醒：阵亡台词有 {len(die)} 句，角色定义要写 dieAudios: {len(die)}，"
                  f"台词键是 #<角色id>1:die、#<角色id>2:die …（写 true 只会读第 1 句）")

    if missing:
        print(f"\n有 {missing} 项素材没落地 —— 上面标 [缺失] 的都补完再来一次。")
        return 1
    print("\n完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
