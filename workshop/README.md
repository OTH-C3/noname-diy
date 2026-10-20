# 无名杀 · DIY 工坊

本地服务 + 单页表单：填设定、裁立绘、预览卡面；提交后产出交接文件，由对话侧 AI 接手。

---

## 启动

```bash
cd <工作区>                                   # 产物输出目录
node <skill目录>/workshop/server/server.mjs

# 或显式指定工作区（免 cd）
DIY_WORKSPACE=/path/to/project node <skill目录>/workshop/server/server.mjs
```

工作区决定扩展输出路径，缺省为启动时 CWD。

**端口**：默认 8765，占用时按序递增（8766 / 8767 / 18765 / 18766 / 28765）。
实际端口以终端输出为准；`DIY_PORT` 可指定（指定后不再回退）。

打开终端输出的 URL（默认 <http://127.0.0.1:8765/>）：

```
⓪ 手上已有做好的卡面图 → 点「武将设定」标题行的「识别卡面」，传一张卡面图（+ 一张立绘原图）
   回对话让 AI 认出来，表单自动填好（默认收起，不占地方）
① 照常填表 + 裁立绘（技能卡仅含名字与效果）
② 右栏底部「更多拓展」→ 页面末段出现第四步（肆）：
   技能台词与配音（随上方技能同步；配音可即时试听）、阵亡台词、皮肤形态
③ 点「提交给 AI」
④ 回对话窗口告知 AI
⑤ AI 读取设定继续（歧义在对话侧弹窗澄清）
```

提交后落盘：

```
<工作区>/.diy-workshop/latest-request.json    表单内容（含 processed 标记，见下）
<工作区>/.diy-workshop/avatar-submitted.jpg   裁剪后的立绘（存在则落盘）
```

走「卡面识别」时另落一份：

```
<工作区>/.diy-workshop/card-source.json          请求：卡面 / 立绘 / 四块放大裁图的路径
<工作区>/.diy-workshop/card/                      这些图本身
<工作区>/.diy-workshop/card-import.json           AI 写回的识别结果（页面每 3 秒取一次）
```

路径与字段见 `references/卡面识别.md`（对话侧照它执行）。

**设计取舍**：网页负责采集，问答留在对话侧 —— 弹窗、文件工具、记忆仅对话侧具备。

**立绘可选**：可整块跳过，AI 交付时提示缺图。

**第四步可选字段（未填则不入 JSON）**：

| 字段 | 格式 | 落盘动作 |
|---|---|---|
| `skills[].lines` / `skills[].audioFiles` | 台词数组；配音为绝对路径，第 n 个 = 第 n 句 | 台词写入 `#<技能id>n`；音频改名 `<技能id>n.mp3` 置 `audio/`，技能上写 `audio: "ext:<扩展名>/audio:<句数>"` |
| `dieLines` | 阵亡台词数组 | 键为 `#<角色id>n:die`，**角色上须写 `dieAudios: <句数>`** —— 写 `true` 仅读第 1 句 |
| `skins` | `[{name, path, tempname?}]`；name 为形态名，tempname 为变身名 | 图改名 `<形态名>.jpg` 置 `skin/<角色id>/`；角色上写 `skinPath: "ext:<扩展名>/skin/<角色id>/"`（不可省，规范 7.5）。带 `tempname` 者走路线 B：`content()` 写 `lib.characterSubstitute` + translate 变身名 + 技能内 `player.changeSkin`（规范 7.7） |
| `guozhanGroup` / `doubleGroups` | 国战归属 / 多势力（仅魏蜀吴群晋） | 角色上写 `groupInGuozhan` / `doubleGroup`，**并**在 packs 的 character 组加 `mode: "guozhan"` —— 不加则国战选不到（规范 7.5） |
| `author` / `version` / `packDisplayName` | 资料页字段与选将包名 | 写进 `package` 与 `info.json`（与 intro 同规矩：payload 未带的键一律不动）。`packDisplayName` 另写入 packs 的 character 组 translate 中 **key 为扩展名**的条目（引擎把该条目转成选将界面的包名） |
| `skills[].types` | 技能类型勾选（随描述关键词自动勾选） | 映射：`locked`→`locked`+`forced`；`limited`→`limited`；`juexingji`/`zhuanhuanji`→对应标签；`zhuSkill`→`zhuSkill`；`dutySkill`→父技能 + success/fail 子技能；`clanSkill`→`clanSkill`（规范 5.2/7.6） |
| `clans` / types 含 `clanSkill` | 宗族名 / 技能标「宗族技」 | 角色上写 `clans: [...]`，技能上写 `clanSkill: true`（规范 7.6）；标 `clanSkill` 则必有 `clans`，检查脚本会抓 |
| `skills[].notes` | 技能补充说明（使命成败 / 觉醒条件 / 转换两态 / 动态显示 / 数值细节等） | 按内容落机制：动态显示按 7.9，使命技按结构，其余写入效果本体 |

素材改名归位有现成脚本：

```bash
python3 scripts/place-assets.py <扩展目录> --char <角色id> --skill "技能名=技能id"
```

立绘、配音、皮肤图一次落位。

---

## 三种「扩展到」

| 模式 | 用途 | 说明 |
|---|---|---|
| 新建扩展 | 从零创建武将 | 扩展名即目录名 |
| 加入已有 | 向现有扩展追加武将 | 选择该扩展的 zip |
| 修改已有 | 修改现有扩展中的某个武将 | 选文件夹 / zip / **工作区里已有的扩展**（不用上传）→ 挑武将 → 自动回填表单 |
| **官方包** | 拿游戏自带的官方武将**当模板**做自己的 | 「选择扩展包」菜单第三项 → 包 → 武将（带搜索）→ 回填表单 + 立绘进裁剪器。**只读**：不回填扩展名、不生成 `editTarget`，落盘一律另建扩展 |

三种上传入口并列在「选择扩展包」菜单里：**选文件夹**（推荐先手动解压）、**选 zip**、**官方包**
（后者不走上传，由服务端直接去游戏目录读）。

**修改已有**为只读：解析武将信息回填表单，用户修改后由 AI 落盘（改前备份、仅动改动字段）。
解析失败的包显式提示手动填写，不猜测、不半填。

---

## 接口

前端由本地服务托管，全部请求为同源路径：

| 接口 | 作用 |
|---|---|
| `POST /api/handoff` | 表单落盘为 `latest-request.json`，并带上 `processed: false` 与 `submittedAt`。**没有队列**：再提交一次会覆盖上一份；但 `processed` 能看出这份做没做（AI 处理完把它改成 `true`） |
| `POST /api/card-source` | 卡面识别：收卡面图 / 立绘原图 / 四块放大裁图，落至 `.diy-workshop/card/` 并写 `card-source.json` |
| `GET /api/card-import` | 取 AI 写好的识别结果（`card-import.json`）；没有则 404 |
| `POST /api/audio` | 接收技能配音，落至 `<工作区>/.diy-workshop/audio/`，返回路径 |
| `POST /api/skin` | 接收皮肤图（前端已裁为 350×464 jpeg），落至 `<工作区>/.diy-workshop/skin/`，返回路径 |
| `POST /api/read-upload` | 解析上传的扩展包（zip / 文件夹），并**在工作区保留一份**供 AI 追加 / 改写 |
| `GET /api/extension-characters` | 列出某扩展内的武将 |
| `GET /api/extensions` | 列出工作区内已有扩展；每项带 `path`，「修改已有」拿它当就地改写落点（只列 `origin` 为「工作区」的，游戏包里那份是只读的） |
| `GET /api/official-packs` | 列出游戏自带的官方包（带试解析出的武将数，读不出武将的不列）；只扫 `character/` |
| `GET /api/official-characters` | 读某个官方包的武将（`?pack=<包名>`），供「当模板」回填表单 |
| `GET /api/avatar` | 取扩展内立绘（官方包的立绘会先复制进工作区，再从这条取） |
| `GET /api/health` | 健康检查；含 `hasSubmit`（工作区里是否已有提交，测试据此跳过真实提交用例） |

**安全边界**：

- 仅监听 `127.0.0.1`，不对外暴露
- 静态服务含目录穿越防护（限工坊目录内文件）
- 上传包先解至临时目录解析，**解析后在工作区保留一份**（`<工作区>/.diy-workshop/uploaded/<扩展名>/`）——
  「加入已有」需追加、「修改已有」需就地改写，删除即丢失落点
- 配音仅接受工作区内音频路径；单文件上限 5MB（音频随扩展分发，过大会无法发送）
- **官方包只读，且只扫 `<游戏>/character/` 这一层**：不碰 `extension/`（UI 美化、特效美化都在那儿），
  也不扫 `image/` 以外的素材与玩法目录；官方武将只能**当模板**，落盘一律另建扩展，绝不写游戏本体
- 运行期产物统一落于 `<工作区>/.diy-workshop/`，不污染扩展源码

---

## 回滚 / 清理

- **中转产物可以直接删**：表单、卡面图、立绘中转、临时解压目录、`official-art/` —— 用到时会重新生成
- **`uploaded/<扩展名>/` 别随手删**：那是「加入已有 / 修改已有」的**改写落点**，
  删了就得让用户重新上传那个包（旧说法「整个 `.diy-workshop/` 可直接删除」是加这个功能之前的，
  按它执行会连落点一起删掉）
- 服务不修改任何全局配置，不影响 agent 的其他用途

---

## 已知限制

- **无并发排队**：同一时间建议只开一个页面提交
- **服务要一直开着**：关掉页面没事，关掉服务（终端里 Ctrl-C 或结束进程）之后就提交不了了；
  用完了直接关，下次要用再起一条命令就行。多开会在 8765 之后顺延端口（8766 / 8767…），
  以终端实际打印的网址为准
- **卡面识别靠对话侧 AI**，不是本地 OCR：网页只负责裁块放大与回填，
  认字交给 AI。所以**识别期间要有人在对话侧**，且结果需人工核对
  （艺术字、残血状态、繁体都有可能认错，认不准的项会留空）
- **解析器只认常规写法**：扩展包（ESM 入口 + 顶层 `const` + `packs`）与**官方包**
  （扁平的 `character/<包>.js`，或一包一目录的 `character/<包>/character.js`）都支持；
  动态生成（版本条件、循环拼接）、`game.import` 独立注册的包解析不了，会提示手动填
- 扩展的**写回由 AI 落盘**，工坊本身不写入用户已有扩展
