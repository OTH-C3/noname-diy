#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""官方技能速查 · 第二步：把提取到的数据整理成速查文档。

输入：extract-skills.mjs 产出的中间 JSON
输出：<skill>/references/skills/ 下的 技能速查-1..5.md + 卡牌与装备.md
      （该目录的 README.md 是手写的，本脚本不碰它）

用法：
  python3 scripts/build-skill-doc.py [中间JSON] [输出目录] [引擎源码根]
  三个参数均可省：
    中间JSON    默认 skills_raw.json（当前目录）
    输出目录    默认 <本脚本>/../references/skills
    引擎源码根  默认取环境变量 DIY_ENGINE_ROOT —— 用来把卡牌从技能里分出去

它做四件事：清洗模板占位与 <br> → 按技能名聚合各版本 → 标注类型与武将归属 → 分片输出。
"""
import json, re, os, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_ROOT = os.path.dirname(HERE)

RAW = sys.argv[1] if len(sys.argv) > 1 else "skills_raw.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(SKILL_ROOT, "reference", "skills")
# 引擎源码根（用来把卡牌从技能里分出去，避免它们混进技能速查）
_root = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("DIY_ENGINE_ROOT", "")
CHAR = os.path.join(_root, "character") if _root else ""
if not CHAR or not os.path.isdir(CHAR):
    print("注意：未提供可用的引擎源码根（第 3 参数或 DIY_ENGINE_ROOT）")
    print("      → 卡牌与装备无法从技能里分出去，会混进技能速查分片")

d = json.load(open(RAW, encoding="utf-8"))
T, C, H = d["translates"], d["characters"], d["heroesOf"]

def tname(key):
    v = T.get(key)
    return v["text"] if v and isinstance(v.get("text"), str) else None

# ── 从源码抓 `const cards = {...}` 的 key，用来把卡牌从技能里分出来 ──
def obj_keys(src, var):
    m = re.search(r"^const\s+" + var + r"\s*=\s*\{", src, re.M)
    if not m:
        return set()
    i, depth, j = m.end(), 1, m.end()
    while j < len(src) and depth:
        ch = src[j]
        if ch == "{": depth += 1
        elif ch == "}": depth -= 1
        j += 1
    body = src[i:j]
    return set(x.group(1) for x in re.finditer(r"^\s{1,4}([A-Za-z_$][\w$]*)\s*:", body, re.M))

CARD_KEYS, SKILL_KEYS = set(), set()
for root, _, files in os.walk(CHAR):
    for fn in files:
        if not fn.endswith(".js"):
            continue
        src = open(os.path.join(root, fn), encoding="utf-8").read()
        CARD_KEYS |= obj_keys(src, "cards")
        SKILL_KEYS |= obj_keys(src, "skills")

PACK_CN = {
    "standard": "标准", "old": "旧版", "refresh": "界", "sp": "SP", "sp2": "SP2",
    "sb": "谋攻", "tw": "十周年", "mobile": "手机", "offline": "线下", "onlyOL": "OL",
    "xianding": "限定", "newjiang": "新将", "yijiang": "一将成名", "huicui": "荟萃",
    "shenhua": "神话再临", "sixiang": "四象", "jsrg": "江山如故",
    "key": "键", "collab": "联动", "shiji": "事迹", "bingshi": "病逝", "clan": "宗族",
    "extra": "额外", "rank": "排位", "diy": "DIY", "sxrm": "杀向热卖",
    "yingbian": "应变", "perfectPairs": "珠联璧合",
}
CN_KINDS = ["锁定技", "限定技", "觉醒技", "转换技", "使命技", "主公技", "宗族技", "衍生技", "阵法技"]
PH = re.compile(r"〖([^〗]*)〗")

def clean(text):
    def sub(m):
        inner = m.group(1)
        if inner == "[object Object]":
            return "【?】"
        if re.fullmatch(r"[A-Za-z_$][\w$]*", inner):
            nm = tname(inner) or tname(re.sub(r"^characterx?_", "", inner))
            return "〖" + nm + "〗" if nm else "〖" + inner + "〗"
        return m.group(0)
    text = PH.sub(sub, text)
    text = text.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n")
    # 官方描述里偶有「花色 + 变体选择符 U+FE0F」的写法，那是让花色按 emoji 渲染的控制字符。
    # 这里剥掉变体选择符与零宽连接符，只留花色符号本身 ——
    # 描述的文字内容不变，只是不再带 emoji 渲染。
    text = text.replace("\ufe0f", "").replace("\ufe0e", "").replace("\u200d", "")
    return re.sub(r"\n{2,}", "\n", text).strip()

def kind_of(text):
    head = text[:16]
    for k in CN_KINDS:
        if k in head:
            return k
    return ""

items = []
for key, v in T.items():
    if not key.endswith("_info"):
        continue
    sid = key[:-5]
    name = tname(sid)
    if not name or sid.endswith("_faq") or name == "FAQ":
        continue
    txt = clean(v["text"])
    if not txt:      # 空描述（占位项）没有参考价值
        continue
    items.append({
        "id": sid, "name": name, "pack": v["pack"],
        "packCN": PACK_CN.get(v["pack"], v["pack"]),
        "heroes": [tname(h) or h for h in H.get(sid, [])],
        "text": txt, "kind": kind_of(txt),
        "isCard": sid in CARD_KEYS,
    })

skills = [it for it in items if not it["isCard"]]
cards = [it for it in items if it["isCard"]]
print("条目：", len(items), "｜ 技能：", len(skills), "｜ 卡牌/装备：", len(cards))

def group_of(lst):
    g = collections.OrderedDict()
    for it in sorted(lst, key=lambda x: (x["name"], x["id"])):
        g.setdefault(it["name"], []).append(it)
    return g

gs = group_of(skills)
withhero = sum(1 for it in skills if it["heroes"])
kinds = collections.Counter(it["kind"] for it in skills if it["kind"])
print("技能名（组）：", len(gs), "｜ 有武将归属：", withhero, "／", len(skills))
print("类型分布：", dict(kinds.most_common()))

META = ("<!--\n  无名杀官方技能速查（自动生成，勿手改）\n"
        "  来源：无名杀引擎源码 character/**，对照 v1.11.5.2 客户端 / 官方 v1.11.6\n"
        "  许可：GPL-3.0（与原游戏一致）\n"
        "  重新生成：见同目录 README.md\n-->\n\n")

def render(g, head, scope):
    lines = [META, "# " + head + "\n", scope + "\n"]
    for nm in g:
        lines.append("### " + nm)
        for it in g[nm]:
            meta = [it["packCN"]]
            if it["heroes"]:
                meta.append("、".join(it["heroes"][:4]) + ("…" if len(it["heroes"]) > 4 else ""))
            elif not it["isCard"]:
                meta.append("非武将技能")
            if it["kind"]:
                meta.append(it["kind"])
            lines.append("- **" + " · ".join(meta) + "** `" + it["id"] + "`")
            for ln in it["text"].split("\n"):
                lines.append("  " + ln)
        lines.append("")
    return "\n".join(lines)

os.makedirs(OUT, exist_ok=True)
SHARDS = 5
names = list(gs.keys())
per = (len(names) + SHARDS - 1) // SHARDS
shards = []
for s in range(SHARDS):
    part = names[s * per:(s + 1) * per]
    if not part:
        continue
    path = os.path.join(OUT, "技能速查-{}.md".format(s + 1))
    open(path, "w", encoding="utf-8").write(render(
        {n: gs[n] for n in part}, "官方技能速查（{}）".format(s + 1),
        "本片：**{}** ～ **{}**（{} 个技能名）\n".format(part[0], part[-1], len(part))))
    shards.append((s + 1, part[0], part[-1], len(part), os.path.getsize(path)))

gc = group_of(cards)
if gc:
    path = os.path.join(OUT, "卡牌与装备.md")
    open(path, "w", encoding="utf-8").write(render(
        gc, "卡牌与装备效果", "共 {} 个名称 {} 条。这些是卡牌/装备，不是武将技能，单独放一处备查。".format(
            len(gc), len(cards))))
    print("卡牌与装备.md", len(gc), "个名称", os.path.getsize(path) // 1024, "KB")

print()
for i, a, b, n, sz in shards:
    print("  技能速查-{}.md  {} ～ {}  {} 个  {} KB".format(i, a, b, n, sz // 1024))

# 统计只打到控制台，不落文件 —— 免得在 references/skills/ 里混进构建产物
print()
print("统计：{} 个技能名 / {} 条技能 / {} 条卡牌；有武将归属 {} 条".format(
    len(gs), len(skills), len(cards), withhero))
if kinds:
    print("类型分布：" + "、".join("{} {}".format(k, v) for k, v in kinds.most_common()))
