#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务端接口契约测试：校验、规范化、安全边界。逐条断言并打印。"""
import json, os, sys, shutil, urllib.request, urllib.error, urllib.parse, base64

# 服务地址：默认 8765。服务多开时端口会顺延，用 DIY_BASE 显式指定 ——
# 否则脚本会打到另一个服务上（工作区一致性自检能拦住，但不如一开始就指对）。
BASE = os.environ.get("DIY_BASE", "http://127.0.0.1:8765")
WS = os.environ.get("DIY_WORKSPACE", "/tmp/clan-ui-ws")   # 与服务端 DIY_WORKSPACE 一致
REQ = os.path.join(WS, ".diy-workshop", "latest-request.json")

# ── 夹具（自建，不依赖工作区预置）────────────────────────────────────
# 两处断言依赖一个「已存在的扩展」：
#   · 「新建同名扩展 → 409」要扫到它才算重名；
#   · 「工作区内图片 → 200」要读到它下面的 png。
# 工作区一般是空的临时目录，所以这里自建；不建的话这两条会假失败
# （2026-10-12 实测：无夹具 49/2，补上后 51/0）。
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_DIR = os.path.join(WS, "扩展源码", "测试包")
FIXTURE_PNG = os.path.join(FIXTURE_DIR, "tg_hero.png")

def prepare_fixture():
    os.makedirs(FIXTURE_DIR, exist_ok=True)
    with open(os.path.join(FIXTURE_DIR, "info.json"), "w", encoding="utf-8") as f:
        json.dump({"name": "测试包", "intro": "契约测试用夹具"}, f, ensure_ascii=False)
    src_png = os.path.join(HERE, "samples", "testgood", "tg_hero.png")
    if os.path.exists(src_png) and not os.path.exists(FIXTURE_PNG):
        shutil.copyfile(src_png, FIXTURE_PNG)

prepare_fixture()

# 「官方包（当模板）」的边界测试要一个**假游戏包**：
#   · character/ 下放一个能读出武将的假官方包 → 该被列出来
#   · extension/ 下放一个「美化包」 → **绝不该**出现在官方包列表里
#     （官方包源只扫 character/，不碰第三方 extension/，这是硬边界）
FAKE_GAME_APP = os.path.join(WS, "假游戏包", "win64", "resources", "app")
FAKE_OFFICIAL_JS = os.path.join(FAKE_GAME_APP, "character", "假官方包.js")
FAKE_EXT_DIR = os.path.join(FAKE_GAME_APP, "extension", "美化包")

def prepare_official_fixture():
    os.makedirs(os.path.dirname(FAKE_OFFICIAL_JS), exist_ok=True)
    with open(FAKE_OFFICIAL_JS, "w", encoding="utf-8") as f:
        f.write(
            'const characters = {\n'
            '\tgs_hero: {\n'
            '\t\tsex: "male",\n'
            '\t\tgroup: "wei",\n'
            '\t\thp: 4,\n'
            '\t\tskills: ["gs_skill"]\n'
            '\t},\n'
            '\t/* 第二个武将的名字刻意不含「假」字：前端用例靠"搜索后候选减少"\n'
            '\t * 验证过滤真的生效，只有 1 个候选时那个断言永远不成立\n'
            '\t * （2026-10-16 踩过同类的坑：bingshi 整包名字都带「势」）。 */\n'
            '\tgs_other: {\n'
            '\t\tsex: "female",\n'
            '\t\tgroup: "shu",\n'
            '\t\thp: 3,\n'
            '\t\tskills: ["gs_skill"]\n'
            '\t}\n'
            '};\n'
            'const translates = {\n'
            '\tgs_hero: "假武将",\n'
            '\tgs_other: "别的武将",\n'
            '\tgs_skill: "假技能",\n'
            '\tgs_skill_info: "锁定技，测试用。"\n'
            '};\n'
        )
    os.makedirs(FAKE_EXT_DIR, exist_ok=True)
    with open(os.path.join(FAKE_EXT_DIR, "extension.js"), "w", encoding="utf-8") as f:
        f.write('export const type = "extension";\nexport default function () { return { name: "美化包" }; }\n')

prepare_official_fixture()

# 「从工作区选择」要一个**装在工作区里**的扩展（不是上传夹具）：
# /api/extensions 会列出它并给出 path —— 「修改已有」拿这个 path 当 uploadPath，
# AI 才知道就地改哪个目录。只要 extension.js 在，listExtensions 就认。
WS_EXT_DIR = os.path.join(WS, "扩展源码", "契约夹具")

def prepare_workspace_ext_fixture():
    # 清掉上一轮"从游戏包复制"造出来的副本：不清的话第二次跑时「美化包」的
    # origin 已经变成「工作区」，就走进"直接用、不复制"分支，
    # "带 copied 标记"那条会假失败（与 card-import.json 同一类坑，10-15 修过同款）。
    for _name in ("美化包", "美化包-副本2", "美化包-副本3"):
        _p = os.path.join(WS, "扩展源码", _name)
        if os.path.isdir(_p):
            shutil.rmtree(_p)
    os.makedirs(os.path.join(WS_EXT_DIR, "character"), exist_ok=True)
    with open(os.path.join(WS_EXT_DIR, "extension.js"), "w", encoding="utf-8") as f:
        f.write('export const type = "extension";\n\nexport default function () {\n\treturn { name: "契约夹具" };\n}\n')
    # 带一个武将：前端用例要验证「选中扩展 → 武将下拉被铺开」，
    # 空包会让那条断言只能退化成"状态行说了 0 个"。
    with open(os.path.join(WS_EXT_DIR, "character", "character.js"), "w", encoding="utf-8") as f:
        f.write(
            'const character = {\n'
            '\tws_hero: {\n'
            '\t\tsex: "female",\n'
            '\t\tgroup: "wu",\n'
            '\t\thp: 3,\n'
            '\t\tskills: ["ws_skill"]\n'
            '\t}\n'
            '};\n'
            'const translate = {\n'
            '\tws_hero: "契约武将",\n'
            '\tws_skill: "契约技",\n'
            '\tws_skill_info: "锁定技，测试用。"\n'
            '};\n'
        )

prepare_workspace_ext_fixture()

ok_n = fail_n = 0
def check(name, cond, detail=""):
    global ok_n, fail_n
    if cond:
        ok_n += 1
        print("  [通过] " + name + ("  — " + str(detail) if detail else ""))
    else:
        fail_n += 1
        print("  [失败] " + name + "  — " + str(detail))

def post(path, obj, raw=None):
    data = raw if raw is not None else json.dumps(obj).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, method="POST",
                                headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"_raw": body}

def get(path):
    try:
        with urllib.request.urlopen(BASE + path, timeout=20) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"_raw": body}

def req_json():
    with open(REQ, encoding="utf-8") as f:
        return json.load(f)

def section(t):
    print("\n== " + t + " ==")

def check_workspace_matches():
    """服务端默认工作区是「启动时的工作目录」，本脚本默认 /tmp/clan-ui-ws —— 两者不一样。
    若只给服务前缀赋值 DIY_WORKSPACE 而没 export（或两边设成了不同目录），
    脚本会去另一个目录读 latest-request.json，得到一堆看不出原因的假失败
    （2026-10-12 已发生：4 条失败，且报错内容对不上，很难看出是路径不一致）。
    所以先自检，不一致就停下并说清怎么改。"""
    try:
        _, j = get("/api/health")
    except Exception as e:
        sys.exit(f"连不上服务 {BASE}：{e}\n先把服务起起来再跑本脚本（见 tests/README.md 第二节）。")
    svc_ws = j.get("workspace")
    if svc_ws and os.path.realpath(svc_ws) != os.path.realpath(WS):
        sys.exit(
            "工作区不一致，请先处理：\n"
            f"  服务在用的工作区   {svc_ws}\n"
            f"  本脚本按           {WS}\n"
            "脚本要读服务写的 latest-request.json，两边必须是同一个目录。\n"
            "改法：export DIY_WORKSPACE=<同一个目录> 之后再起服务，然后再跑本脚本。"
        )

check_workspace_matches()

# ── 扩展名校验 ─────────────────────────────────────────────────────────
section("扩展名校验")
s, j = post("/api/handoff", {"extName": "", "name": "x"})
check("空扩展名 → 400", s == 400 and "扩展名" in j.get("error", ""), f"{s} {j.get('error')}")

s, j = post("/api/handoff", {"extName": "a/b", "name": "x"})
check("含 / → 400", s == 400, f"{s} {j.get('error')}")

s, j = post("/api/handoff", {"extName": 'a\\b', "name": "x"})
check("含反斜杠 → 400", s == 400, f"{s} {j.get('error')}")

s, j = post("/api/handoff", {"extName": "a:b", "name": "x"})
check("含冒号 → 400", s == 400, f"{s} {j.get('error')}")

s, j = post("/api/handoff", {"extName": "a#b", "name": "x"})
check("含 # → 400", s == 400 and "#" in j.get("error", ""), f"{s} {j.get('error')}")

s, j = post("/api/handoff", {"extName": "a%b", "name": "x"})
check("含 % → 400", s == 400 and "%" in j.get("error", ""), f"{s} {j.get('error')}")

s, j = post("/api/handoff", {"extName": "..", "name": "x"})
check("扩展名为 .. → 400", s == 400, f"{s} {j.get('error')}")

s, j = post("/api/handoff", {"extName": "boss", "name": "x"})
check("官方玩法保留名 boss → 400", s == 400 and "自带" in j.get("error", ""), f"{s} {j.get('error')}")

s, j = post("/api/handoff", {"extName": "测试包", "name": "x", "extMode": "new"})
check("新建同名扩展 → 409 冲突", s == 409 and j.get("conflict", {}).get("name") == "测试包",
      f"{s} {j.get('error')}")

s, j = post("/api/handoff", {"extName": "测试包", "name": "x", "extMode": "edit"})
check("修改已有时不查重 → 200", s == 200, f"{s} {j.get('error', '')}")

s, j = post("/api/handoff", {"extName": "  ", "name": "x"})
check("纯空白扩展名 → 400", s == 400, f"{s} {j.get('error')}")

# 落盘件要带 processed / submittedAt：没有队列（两次提交会覆盖前一份），
# 但这两个字段至少能让人看出「最新那份做没做」。
# 注意这条会真的写文件 —— 下面立刻删掉，否则前端用例会以为「已有提交」而少跑两条。
_req = os.path.join(WS, ".diy-workshop", "latest-request.json")
s, j = post("/api/handoff", {"extName": "契约包", "name": "契约武将", "extMode": "new"})
check("合法提交 → 200", s == 200 and j.get("ok"), f"{s} {j.get('error', '')}")
_reqData = json.load(open(_req, encoding="utf-8"))
check("落盘带 processed=false（AI 处理完改成 true）",
      _reqData.get("processed") is False, str(_reqData.get("processed")))
check("落盘带 submittedAt",
      bool(_reqData.get("submittedAt")), str(_reqData.get("submittedAt")))
check("落盘带扩展名（AI 靠它决定落哪个目录）",
      _reqData.get("extName") == "契约包", str(_reqData.get("extName")))
# 不在这里删 —— 后面的「字段规范化」还会再写一次。统一在文件末尾清。

# ── 字段规范化 ─────────────────────────────────────────────────────────
section("字段规范化")
s, j = post("/api/handoff", {
    "extName": "规范化测试", "name": "喵", "title": "号", "group": "wu",
    "groupCustom": "喵族", "sex": "female", "hp": "4/4/2",
    "skills": [
        {"name": "技一", "desc": "描述一", "sample": True, "types": ["locked", "junk", "limited", "locked"],
         "lines": ["台词1", "", "  ", "台词2"], "notes": "  补充  ",
         "audioFiles": [f"{WS}/.diy-workshop/audio/a.mp3", "/etc/passwd", "x.mp3"]},
        {"name": "", "desc": "", "types": ["nope"]},
        {"name": "", "desc": "", "audioFiles": [f"{WS}/.diy-workshop/audio/b.mp3"]},
    ],
    "intro": "  包介绍  ", "dieLines": [" 阵亡1 ", "", "阵亡2"],
    "clans": ["吴郡喵氏", "吴郡喵氏", "", "颍川荀氏", "c3", "c4", "c5", "c6"],
    "guozhanGroup": "jin", "doubleGroups": ["wei", "wei", "bogus", "jin"],
    "characterIntro": "列传正文",
    "author": " 作者 ", "version": " 1.0 ", "packDisplayName": " 包名 ",
    "skins": [
        {"name": "形态1", "path": f"{WS}/.diy-workshop/skin/a.jpg", "tempname": "变身名超长的测试应该被截断到二十个字以内"},
        {"name": "形态1", "path": f"{WS}/.diy-workshop/skin/b.jpg"},
        {"name": "", "path": f"{WS}/.diy-workshop/skin/c.jpg"},
        {"name": "坏路径", "path": "/etc/passwd"},
        {"name": "坏后缀", "path": f"{WS}/.diy-workshop/skin/d.txt"},
    ],
}, )
check("提交成功", s == 200, f"{s} {j}")
p = req_json()
check("扩展名已 trim", p["extName"] == "规范化测试", p["extName"])
check("自定义势力时 group 留原值（服务端不覆盖）", p["group"] == "wu", p["group"])
check("hp 原样落", p["hp"] == "4/4/2", p["hp"])
sk = p["skills"]
check("技能只留 name/desc/types/lines/notes/audioFiles",
      set(sk[0].keys()) <= {"name", "desc", "types", "lines", "notes", "audioFiles"},
      ",".join(sorted(sk[0].keys())))
check("sample 等界面字段没进交付文件", "sample" not in sk[0], ",".join(sk[0].keys()))
check("非法类型被剔除、重复被去重",
      sk[0].get("types") == ["locked", "limited"], sk[0].get("types"))
check("台词去空去重空白", sk[0].get("lines") == ["台词1", "台词2"], sk[0].get("lines"))
check("notes 已 trim", sk[0].get("notes") == "补充", repr(sk[0].get("notes")))
check("越界音频路径被剔除",
      sk[0].get("audioFiles") == [f"{WS}/.diy-workshop/audio/a.mp3"],
      sk[0].get("audioFiles"))
check("完全空的技能被剔除（起手那张「示例位」不该交给 AI）", len(sk) == 2, len(sk))
check("被剔除的正是那张没写字的空壳", [x.get("name", "") for x in sk] == ["技一", ""], [x.get("name", "") for x in sk])
check("只有配音、没写字的技能被保留（配音是用户真意图）",
      any(x.get("audioFiles") and not x.get("name") for x in sk),
      [x.get("audioFiles") for x in sk])
check("intro 已 trim 且落键", p.get("intro") == "包介绍", repr(p.get("intro")))
check("阵亡台词去空", p.get("dieLines") == ["阵亡1", "阵亡2"], p.get("dieLines"))
check("宗族去重去空且最多 5 个",
      p.get("clans") == ["吴郡喵氏", "颍川荀氏", "c3", "c4", "c5"], p.get("clans"))
check("多势力去重且只留合法值",
      p.get("doubleGroups") == ["wei", "jin"], p.get("doubleGroups"))
check("国战归属落键", p.get("guozhanGroup") == "jin", p.get("guozhanGroup"))
check("列传落键", p.get("characterIntro") == "列传正文", p.get("characterIntro"))
check("作者/版本/包名已 trim",
      (p.get("author"), p.get("version"), p.get("packDisplayName")) == ("作者", "1.0", "包名"),
      (p.get("author"), p.get("version"), p.get("packDisplayName")))
check("皮肤同名去重", [x["name"] for x in p.get("skins", [])] == ["形态1"], p.get("skins"))
check("皮肤变身名截到 20 字",
      len(p["skins"][0].get("tempname", "")) == 20, p["skins"][0].get("tempname"))
check("皮肤只留 name/path/tempname",
      set(p["skins"][0].keys()) <= {"name", "path", "tempname"}, ",".join(p["skins"][0].keys()))

section("空值不落键（保护已有扩展的字段不被清空）")
s, j = post("/api/handoff", {"extName": "空值测试", "name": "喵", "extMode": "edit",
                             "intro": "   ", "dieLines": ["", " "], "clans": [],
                             "doubleGroups": [], "guozhanGroup": "bogus",
                             "author": "  ", "version": "", "packDisplayName": "",
                             "characterIntro": "  ", "skins": [], "skills": []})
check("提交成功", s == 200, f"{s} {j}")
p = req_json()
missing = [k for k in ("intro", "dieLines", "clans", "doubleGroups", "guozhanGroup",
                       "author", "version", "packDisplayName", "characterIntro", "skins")
           if k in p]
check("空字段一律不落键", not missing, "仍然出现：" + ",".join(missing))

section("非法请求体")
s, j = post("/api/handoff", None, raw=b"{ not json")
check("坏 JSON → 400", s == 400, f"{s} {j.get('error')}")

section("素材上传接口")
s, j = post("/api/skin", {"name": "x", "data": "data:text/plain;base64,aGk="})
check("非图片 dataURL → 400", s == 400, f"{s} {j.get('error')}")
s, j = post("/api/audio", {"name": "x", "data": "data:image/png;base64,aGk="})
check("非音频 dataURL → 400", s == 400, f"{s} {j.get('error')}")
s, j = post("/api/skin", {"name": "x", "data": "data:image/png;base64,"})
check("空图片 → 400", s == 400, f"{s} {j.get('error')}")

# 最小合法 1×1 PNG（base64）
png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
s, j = post("/api/skin", {"name": "测试形态", "data": "data:image/png;base64," + png})
check("合法图片 → 200 并返回路径", s == 200 and os.path.exists(j.get("path", "")),
      f"{s} {j.get('path')}")
if s == 200:
    check("落盘文件名带中文形态名", "测试形态" in os.path.basename(j["path"]), os.path.basename(j["path"]))

s, j = post("/api/audio", {"name": "语音", "data": "data:audio/mpeg;base64," + base64.b64encode(b"\x00" * 32).decode()})
check("合法音频 → 200 并返回路径", s == 200 and os.path.exists(j.get("path", "")),
      f"{s} {j.get('path')}")
if s == 200:
    check("音频扩展名归一（mpeg → mp3）", j["path"].endswith(".mp3"), os.path.basename(j["path"]))

section("路径穿越与只读接口")
s, j = get("/api/avatar?path=/etc/passwd")
check("读 /etc/passwd → 403", s == 403, f"{s} {j.get('error')}")
s, j = get("/api/avatar?path=../../etc/passwd")
check("相对路径穿越 → 403", s == 403, f"{s} {j.get('error')}")
s, j = get("/api/avatar?path=" + urllib.parse.quote(os.path.join(WS, "扩展源码/测试包/info.json")))
check("工作区内非图片 → 403", s == 403, f"{s} {j.get('error')}")
# 图片响应不是 JSON，单独处理
_u = urllib.parse.quote(os.path.join(WS, "扩展源码/测试包/tg_hero.png"))
try:
    with urllib.request.urlopen(BASE + "/api/avatar?path=" + _u, timeout=20) as _r:
        _ct = _r.headers.get("content-type", ""); _b = _r.read()
    check("工作区内图片 → 200 且是图片", _r.status == 200 and _ct.startswith("image/") and len(_b) > 0,
          f"{_r.status} {_ct} {len(_b)}B")
except urllib.error.HTTPError as e:
    check("工作区内图片 → 200 且是图片", False, f"{e.code}")
s, j = get("/api/extension-characters")
check("缺 name 参数 → 400", s == 400, f"{s} {j.get('error')}")
s, j = get("/api/extension-characters?name=" + urllib.parse.quote("不存在的包"))
check("未知扩展 → 404", s == 404, f"{s} {j.get('error')}")
s, j = get("/api/extensions")
check("扩展列表可用", s == 200 and j.get("ok"), f"{s} {len(j.get('extensions', []))} 个")

# ── 工作区扩展列表 ─────────────────────────────────────────────────────
# 「修改已有」不再逼用户去找 zip：直接列出工作区里的扩展、选中即用。
# 关键是 path —— 它就是 AI 就地改写的落点，且**必须落在工作区内**
# （指到游戏本体就等于往只读的游戏包里写，那是红线）。
section("工作区扩展列表")
s, j = get("/api/extensions")
_exts = j.get("extensions") or []
_names = [e.get("name") for e in _exts]
check("扩展列表可用", s == 200 and j.get("ok"), f"{s} {len(_exts)} 个")
check("列出了工作区里的扩展", "契约夹具" in _names, str(_names[:8]))
_fix = next((e for e in _exts if e.get("name") == "契约夹具"), None)
check("每项带 path（「修改已有」拿它当 uploadPath）",
      bool(_fix and _fix.get("path")), str(_fix)[:140])
check("path 是真实存在的目录",
      bool(_fix and _fix.get("path") and os.path.isdir(_fix["path"])),
      str(_fix and _fix.get("path")))
check("path 落在工作区内（不会指到游戏本体）",
      bool(_fix and str(_fix.get("path", "")).startswith(WS)),
      str(_fix and _fix.get("path")))

# 复制：游戏包里那份只读，选中时先复制成工作区副本，之后改动都落在副本上
s, j = post("/api/import-extension", {"name": "美化包"})
_copied = j.get("path") or ""
check("从游戏包复制扩展 → 200", s == 200 and j.get("ok"), f"{s} {j.get('error', '')}")
check("复制后路径落在工作区", _copied.startswith(WS), _copied)
check("复制真的落了盘", bool(_copied) and os.path.isdir(_copied), _copied)
check("带 copied 标记", j.get("copied") is True, str(j)[:120])
check("复制出来的目录名沿用原名（工作区里没有同名，不必加后缀）",
      bool(_copied) and os.path.basename(_copied) == "美化包", _copied)

# 再调一次：此时 listExtensions 扫到的「美化包」已经是工作区里那份了，
# 所以**不该再复制**（否则每点一次就多一个副本）。这是正确行为。
s2, j2 = post("/api/import-extension", {"name": "美化包"})
check("已复制过的再调一次 → 不重复复制，路径不变",
      s2 == 200 and j2.get("path") == _copied and j2.get("copied") is False,
      f"{s2} path={j2.get('path')} copied={j2.get('copied')}")

s3, j3 = post("/api/import-extension", {"name": "契约夹具"})
check("本来就在工作区里的扩展 → copied=false 且路径不变",
      s3 == 200 and j3.get("copied") is False and j3.get("path") == WS_EXT_DIR,
      f"{s3} {str(j3)[:120]}")

s4, j4 = post("/api/import-extension", {"name": "根本没有这个扩展"})
check("不存在的扩展 → 404", s4 == 404, f"{s4} {j4.get('error', '')}")
s5, j5 = post("/api/import-extension", {})
check("缺 name → 400", s5 == 400, f"{s5} {j5.get('error', '')}")

# ── 官方包（当模板读）──────────────────────────────────────────────────
# 核心是**边界**：只扫游戏包里的 character/，绝不把第三方 extension/
# （UI 美化、特效美化那些）当成官方包读进来。
section("官方包")
s, j = get("/api/official-packs")
_names = [p.get("name") for p in (j.get("packs") or [])]
check("官方包列表可用", s == 200 and j.get("ok"), f"{s} {len(_names)} 个")
check("列出了 character/ 下的假官方包", "假官方包" in _names, str(_names[:6]))
check("没把 extension/ 下的扩展当官方包", "美化包" not in _names, str(_names[:6]))

s, j = get("/api/official-characters?pack=" + urllib.parse.quote("假官方包"))
_chars = j.get("characters") or []
check("读官方包 → 200 且标 readonly（只能另建扩展）",
      s == 200 and j.get("readonly") is True, f"{s} readonly={j.get('readonly')}")
_gs = next((c for c in _chars if c.get("name") == "假武将"), None)
check("读出武将：名字 / 技能名 / 技能描述都在",
      bool(_gs)
      and (_gs.get("skills") or [{}])[0].get("name") == "假技能"
      and (_gs.get("skills") or [{}])[0].get("desc") == "锁定技，测试用。",
      str(_chars[:2])[:140])

s, j = get("/api/official-characters?pack=" + urllib.parse.quote("美化包"))
check("拿第三方扩展名读官方包 → 404", s == 404, f"{s}")
s, j = get("/api/official-characters?pack=" + urllib.parse.quote("../美化包"))
check("包名带 .. → 400（挡住路径穿越）", s == 400, f"{s} {j.get('error')}")
s, j = get("/api/official-characters")
check("缺 pack 参数 → 400", s == 400, f"{s} {j.get('error')}")

# ── 卡面识别 ───────────────────────────────────────────────────────────
section("卡面识别")

# 1×1 透明 PNG —— 服务端只按 dataURL 的头存文件、不解析图片内容，够用
TINY_PNG = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
            "AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

# 这一项断言「还没有结果时是 404」，所以先清掉可能残留的上一轮结果 ——
# 本脚本下面会自己写一份 card-import.json 来测 200，不清的话第二次跑必假失败
# （同一工作区连跑两次：第一次 59/0，第二次 58/1）。
_CARD_IMPORT = os.path.join(WS, ".diy-workshop", "card-import.json")
if os.path.exists(_CARD_IMPORT):
    os.remove(_CARD_IMPORT)

s, j = get("/api/card-import")
check("AI 还没写结果时 → 404", s == 404, f"{s} {j}")

s, j = post("/api/card-source", {"card": TINY_PNG})
check("只传卡面也收（立绘与裁块都是可选）", s == 200 and "card" in j.get("saved", {}), f"{s} {j}")

s, j = post("/api/card-source", {
    "card": TINY_PNG, "art": TINY_PNG,
    "parts": {"group": TINY_PNG, "pips": TINY_PNG, "name": TINY_PNG, "skill": TINY_PNG},
    "cardSize": {"w": 739, "h": 1064},
})
keys = sorted(j.get("saved", {}).keys()) if s == 200 else []
check("卡面 + 立绘 + 四个裁块全部落盘",
      s == 200 and keys == ["art", "card", "part-group", "part-name", "part-pips", "part-skill"],
      f"{s} {keys}")

s, j = post("/api/card-source", {"card": TINY_PNG, "parts": {"../evil": TINY_PNG, "ok": TINY_PNG}})
keys = sorted(j.get("saved", {}).keys()) if s == 200 else []
check("裁块键名带路径字符 → 丢弃，只留合法的", s == 200 and keys == ["card", "part-ok"], f"{s} {keys}")

check("card-source.json 已写（AI 靠它找到图）",
      os.path.exists(os.path.join(WS, ".diy-workshop", "card-source.json")))

s, j = post("/api/card-source", {"art": TINY_PNG})
check("只传立绘 → 200（AI 只负责把立绘存进扩展，不认字）",
      s == 200 and "art" in j.get("saved", {}), f"{s} {j}")

s, j = post("/api/card-source", {"card": "data:text/plain;base64,aGk="})
check("非图片 dataURL → 400", s == 400, f"{s} {j.get('error')}")

with open(os.path.join(WS, ".diy-workshop", "card-import.json"), "w", encoding="utf-8") as f:
    json.dump({"name": "测", "hp": "3/3/0"}, f, ensure_ascii=False)
s, j = get("/api/card-import")
check("AI 写好后 → 200 且内容取得到", s == 200 and j.get("name") == "测", f"{s} {j}")

# 跑完清掉自己写的那份 card-import.json。
# 不清的话，之后谁打开工坊页面（包括前端测试）都会被初始化读取填上一份 "测" ——
# 前端现在一加载就主动读一次已有结果，读到的正是这份残留（2026-10-17 实测：
# 前端 1.3「卡面默认名 = 灰猫」被它打挂）。
try:
    os.remove(os.path.join(WS, ".diy-workshop", "card-import.json"))
except OSError:
    pass

# 同样清掉 latest-request.json —— 本脚本中途会写好几份（handoff 成功路径）。
# 不清的话，下次服务启动时 `hasSubmit` 会变成 true，前端的「真实提交」两条用例
# 就会被跳过（总数少 2），看起来像"测试少了"。
for _stale in ("latest-request.json", "card-import.prev.json"):
    try:
        os.remove(os.path.join(WS, ".diy-workshop", _stale))
    except OSError:
        pass

print(f"\n=== 服务端契约：通过 {ok_n} 项，失败 {fail_n} 项 ===")
sys.exit(1 if fail_n else 0)
