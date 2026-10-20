---
name: noname-diy
description:
  把中文武将技能描述翻译成无名杀（noname）可运行的扩展代码，并打包成可导入游戏的 zip。
  触发：提及"无名杀"或"帮我做个武将"；给出中文技能描述要求实现；要求改某扩展的技能写法；
  反馈"武将不出现 / 技能没反应 / 加了没效果"；需要校验或打包扩展。
license: GPL-3.0
agent_created: true
metadata:
  author: OTH-C3
  version: "1.1"
  verified_against: 无名杀 v1.11.5.2 实测 / 官方 v1.11.6 源码
---

# 无名杀 DIY 武将

> **本目录只读**：改动会被更新整包覆盖，经验去向见文末「经验沉淀」。

把中文技能描述翻译为可加载的武将扩展包。

## 对用户的输出

**用户非技术背景。** 四条硬约束：

- **简短**：结论先行、过程在后；三句可述则不写三段；不复述需求求确认。
- **无术语**：对用户不给计算机词，说人话（词表 + **哪些概念不许回避**见接手流程「阶段 4」）。文件位置给完整可复制值，不说「已导出」。
- **主体是武将**：名字、称号、势力、体力、技能效果、上手玩法。
- **杂项殿后**：环境、工具、文档等与武将无关者置于末节，无则省略。

## 网页工坊（默认入口）

开工即启动并告知 URL（已在运行则跳过）：

```bash
node <skill目录>/workshop/server/server.mjs
# 输出实际 URL，默认 http://127.0.0.1:8765/（端口占用自动递增）
```

提交后落盘：

```
<工作区>/.diy-workshop/latest-request.json    表单
<工作区>/.diy-workshop/avatar-submitted.jpg   立绘（存在则落盘）
```

亦可纯对话模式（用户有现成卡面图时走「卡面识别」，见 `references/卡面识别.md`）。细节 → `workshop/README.md`。

---

## 最小可跑骨架

三文件按下述结构即可被引擎加载（**完整注释模板见 `assets/template/`，直接复用**）：

```
扩展名/                      目录名必须等于 extension.js 的 name
├── extension.js             从 "../../noname.js" 导入 + export const type = "extension"
├── info.json                六字段：name / intro / author / diskURL / forumURL / version
├── <角色id>.jpg             350 x 464
└── character/character.js   角色 + 技能 + 翻译 + packs
```

**`character/character.js` 结构最易错**，记六条：

```js
const characters = { <角色id>: { sex, group, hp, skills: [...] } };
const skills = { <技能id>: { trigger, filter, content } };
const translates = { <角色id>, <技能id>, <技能id>_info, <技能id>_bg };
const characterTitles = { <角色id>: "<称号>" };
const characterSort = { <扩展名>: { <分组id>: [<角色id>] } };  // 第一层 key = pack 的 name
const characterSortTranslate = { <分组id>: "自制武将" };

export const packs = {
	character: {
		connect: true,
		character: characters,
		characterSort,
		characterTitle: characterTitles,
		translate: { ...translates, ...characterSortTranslate, <扩展名>: "<显示名>" },
	},
	skill: { skill: skills, translate: translates },
};
```

完成后立即校验：

```bash
node --check character/character.js
node scripts/check-extension.mjs <扩展目录> [引擎源码根]
```

> `[引擎源码根]` 可省（脚本自行检索；未命中则跳过时机名 / id 冲突 / 引擎 API 三项检查）。
> 定位用户的无名杀 → `references/无名杀接手流程.md`「阶段 0」。

---

## 策略哲学

### 一、复用的是「原子操作」，不是「技能」

目标技能通常不存在，但零件几乎总能找到先例。四层退让（**抄零件时 `ai` 一并带走**，漏了手操正常、AI 哑火）：

| 层 | 情况 | 做法 |
|---|---|---|
| 1 | 整个技能现成 | 直接复用（例：宗族技 → `clanzhongliu`） |
| 2 | 骨架现成（时机、结构相同） | 复用骨架 |
| 3 | 拆为原子操作 | **逐个复用零件的现成写法** ← 多数情况 |
| 4 | 零件亦无先例 | 读 API 签名自行组合，写法上预留改动余地 |

> **底线**：连"该用哪些 API"都定不下来，是设计超出引擎能力，不是编码问题。
> 停止并请用户改设计。**禁止硬编只能过语法检查的假实现**，危害大于不写。

实例 → `references/无名杀规范.md` 6.0 节。

> `references/skills/` **非唯一来源、亦非权威**：由本机引擎源码导出，未必含最新线上武将，
> 也不是官方原文。**未收录 ≠ 不存在** → 转查引擎源码 `character/**` 或官方线上资料，
> 勿因未命中即判定「无此技能」。

### 二、技能无反应时，先自查字段缺失

引擎大量静默失败（id 冲突、缺 `connect`、`packs` 结构错误、时机名拼错 —— 均无报错）。
遇「技能不触发 / 武将不出现」，先按「惰性知识」自查，勿先疑引擎缺陷。

### 三、交付前必须过静态检查

`node --check` 仅查语法，漏作用域与结构错误（实例：函数定义缺失、调用处仍在 → 运行即崩，语法全过）。
必须再跑 `scripts/check-extension.mjs`。

---

## 工作流程

**完整流程与汇报格式 → `references/无名杀接手流程.md`**，此处仅列要点。

**首步恒为查环境**（缺失则让用户安装，勿硬做、勿绕开）：`node -v`、
`python3 --version`（Windows 先试 `python --version`，再 `py --version`）。每会话一次。
话术见「阶段 0」（不用「环境 / 依赖 / 运行时」等词）。

**环境就绪即启动工坊并告知 URL**（默认入口）；亦可纯对话模式。

用户报「我提交了」后按四阶段执行：

| 阶段 | 动作 | 关键约束 |
|---|---|---|
| **1 接手** | 读 `<工作区>/.diy-workshop/latest-request.json`；校验必填、查重、核立绘 | **重名必停下询问**，不覆盖他人扩展 |
| **2 理解** | ① 用自己的话复述技能 ② 比对合理性，**离谱/矛盾/与规则冲突须直说** ③ 歧义**一次问完** | 复述是给用户打断机会，非求确认 |
| **3 实现** | **定形状基准**（结构照能跑的扩展写；要件与语义查 `references/`）→ 定技能 → 写代码 → `node --check` → 静态检查 → 过避坑清单 → 打包 | **打包后必须给完整导出路径** |
| **4 汇报** | **武将置最前** → 使用方式 → 默认裁决 → **杂项置末节** | 路径 / 默认裁决，二者不可省 |

**纯对话需求**（无工坊提交）：跳过阶段 1，但需求须问全 —— 技能描述让用户**照原文念**，不得自行总结。

**缺立绘须提醒**：不影响运行，但选将时牌面空白；可补 350×464 图或用工坊裁剪。

---

## 惰性知识（易忘，须点名）

- **`packs` 为两层结构**（`character` / `skill`），非平铺 —— 形状见「最小可跑骨架」
- **扩展名四处一致**：目录名 / `info.json` / `extension.js` 的 `name` / `characterSort` 首层 key
- **`characterSort` 第一层 key = 本 pack 的 name**（`packs` 写法下引擎强制等于扩展名）
- **锁定技**：`locked: true` 仅控 UI 标签，**是否强制发动取决于 `forced`** —— 漏写即成「可被拒绝的锁定技」
- **`marktext` 仅在子技能展开时写 `<id>_bg`** —— 直接定义的技能用不到
- **`ai` 不写不报错、只影响 AI 操控时的决策**（玩家手操完全不受影响）；但**视为技必写** `respondShan`/`respondTao`（否则 AI 只看手牌、不来响应）。要写就抄官方同类技能整块，不自编
- **对象参数 API 需 v1.11.3+**，旧版静默失效 → 分发优先用旧式位置参数
- **放入 `extension/` 的扩展默认关闭**，须在游戏「扩展」页手动启用
- **选将池由房主构建**：房主未安装的武将，全员不可选
- **`group` 与 `subSkill` 不同**：以 `group` 引用独立技能须补 `sub: true` + `sourceSkill`
- **新建前必查重**（`扩展源码/<名>`、游戏包 `extension/<名>`）—— 已存在却按新建处理**会覆盖他人扩展**
- **自定义势力须注册**：`content` 内 `game.addGroup(id, "简称", "全名", { color: "#rrggbb" })`，裸写字符串会丢配色/国战语义（规范 7.4）
- **台词不出字幕**：`"#<角色id>n:die"` / `"#<技能id>n"` 仅在**武将详情页**显示；要发声须有音频文件（规范 8.1）
- **`addGaintag` 前必须 `gain`**（牌不在场上时静默跳过）
- **所有展示给玩家的 id 须有翻译**：技能名 / `_info` / 分组名 / gaintag / `_bg`
- **分派子任务只给目标与标准，不给手段** —— 措辞即隐性规则

> 完整清单与出处 → `references/无名杀规范.md`。

---

## 高危边界（不可违反）

- **禁止修改用户的技能描述** —— 技能名与描述**一字不改**录入 `translate`；错别字、标点异常、啰嗦亦仅**向用户指出**，禁止「擅自改通顺」——任何改动须经用户同意。
- **禁止给描述加它没写的限制** —— 没说「限一次」别加 `usable: 1`，没说「必须有牌」别加 `filter` 条件。要加先问。
- **禁止修改游戏本体** —— 仅产出独立扩展（不动 `noname/`、`resources/app/` 下任何文件）
- **禁止用 `==` 比较版本号** —— 实例：`lib.version == '1.11.4.1'` 导致整个扩展一个武将都不加载
- **牌会流动** —— 打标记前须确定：牌离开原位后标记如何处理
- **`onremove` 须区分「可丢弃的状态」与「须归还的资源」** —— 游戏外（`ui.special` / 武将牌上）的牌直接 `delete` 会致其**永久消失**

---

## 脚本

```bash
# 静态检查（15 项，清单见脚本头部）
node scripts/check-extension.mjs <扩展目录> [引擎源码根]

# 查官方技能：同名各版本并列 + 能否直接复用 content
node scripts/search-skill.mjs <技能名或关键词>

# 素材归位：立绘/配音/皮肤图按引擎命名规则改名并放入扩展目录
python3 scripts/place-assets.py <扩展目录> --char <角色id> --skill "技能名=技能id"

# 重刷 references/skills/（官方技能速查）：换游戏版本后才需要
node scripts/extract-skills.mjs <引擎源码根> /tmp/skills_raw.json
python3 scripts/build-skill-doc.py /tmp/skills_raw.json references/skills <引擎源码根>

# 打包为可导入的 zip（zip 根目录直接是 extension.js）
python3 scripts/pack-extension.py <扩展目录> [输出.zip]     # Linux / macOS
python scripts/pack-extension.py <扩展目录> [输出.zip]      # Windows：仅有 python.exe / py.exe
```

**检查脚本是闸门，非权威**：报错须修；无报错亦不代表全对 —— 它只覆盖已写入的检查项。
**改动检查脚本后，必须用正样本 + 故意写坏的样本各跑一次**。

---

## 参考文档（按需读，勿一次读全）

| 文档 | 读取时机 |
|---|---|
| `references/无名杀接手流程.md` | **用户报「我提交了」时照此执行**：阶段 0 环境自检 + 四阶段流程 + 汇报格式 |
| `references/无名杀扩展写法.md` | 制作途径 / 写法：官方脚手架、游戏内制作、手写、第三方工具 |
| `references/无名杀规范.md` | **字段与写法不确定时首选**：字段全表、常用写法、加载机制、素材路径、授权分发 |
| `references/version-notes/` | **开工前先读**：该版本可用 API 与已知易错点 + 文末「本机增量」 |
| `references/无名杀武将指南.md` | 从零上手：字段表、技能模板、完整流程 |
| `references/无名杀技能系统.md` | 查细节：时机名全集、mod 逐键、API 签名 |
| `references/无名杀避坑清单.md` | 动手前扫一遍：8 类根因 + 10 条自检 |
| `references/无名杀设计审查清单.md` | **理解需求时逐类过**：六类设计错误（数值失真 / 逻辑矛盾 / 规则冲突 / 时机对不上 / 引擎卡死 / AI 自己加戏）+ 什么情况必须查规则集 |
| `references/无名杀规则集要点.md` | 技能描述涉规则判定时（拼点、距离、结算顺序等）—— **320K** |
| `references/skills/` | **引用官方技能 / 找同类机制**：3790 个技能名、5389 条描述 —— **1.4M** |

**大文件先 grep 定位再读命中段**（320K / 1.4M 整篇读会挤爆上下文）：

```sh
grep -n "铁骑" references/skills/技能速查-*.md   # 技能名（分片通配）
grep -n "拼点" references/无名杀规则集要点.md     # 规则主题
grep -rln "时机名" references/                   # 先定位在哪份文档
```

结论多标 `文件:行号`。

---

## 经验沉淀（完成后回写）

**写 `references/version-notes/<版本>.md` 文末的「本机增量」小节** —— 那是引擎经验的唯一落点：
该文件的基线部分随游戏版本整段换新，本机增量段由 `scripts/update-skill.py` 在更新时合并保留。

- 只写基线里没有的；基线失效写成「推翻第 N 条：…」
- 每条带日期 + 结论 + 出处（源码核对 / 官方样例 / 实测）
- 用户偏好、项目约定不写这里 —— 那是你自己的工作记忆

```md
- **2026-10-12** `player.xxx()` 参数 2 是 <语义>（源码 `xxx.js:123` 核对）
```
