# 测试

三层，由外到内。仓库自带的 CI 只跑第一层（不需要起服务）。

## 一、样本自检（CI 里跑，不需要服务）

```sh
node scripts/check-extension.mjs tests/samples/testgood /path/to/引擎源码   # 22 通过 / 0 错误，退出 0
node scripts/check-extension.mjs tests/samples/testbad                      # 16 通过 / 7 错误，退出 1
python3 scripts/pack-extension.py tests/samples/testgood /tmp/out.zip
```

带上引擎源码根会多跑「时机名核实 / id 撞名 / 引擎 API 存在性」三类；
不传时脚本会自行检索，找不到就跳过那三类（通过项数随之减少，属正常）。

## 二、服务端接口契约（需要服务在跑）

校验、规范化、安全边界。逐条断言，最后打印「通过 N 项，失败 M 项」。
**预期结果：通过 85 项，失败 0 项**（空工作区直接跑也应是这个数；连跑两遍也应是这个数）。
脚本跑完会自己清掉 `latest-request.json` / `card-import.json` —— 不清的话下次服务启动会把
`hasSubmit` 判成 true，前端那两条「真实提交」用例就会被跳过。
**可以重复跑**：脚本会先清掉自己上一轮写下的 `card-import.json`
（否则「还没写结果时应 404」那条会在第二次跑时假失败，2026-10-15 修）。
脚本还自建一个**假游戏包**（`<工作区>/假游戏包/win64/resources/app/`）：
`character/` 下放一个能读出武将的假官方包、`extension/` 下放一个「美化包」——
用来验证「官方包只扫 character/，绝不把第三方扩展当官方包」这条边界。

```sh
export DIY_WORKSPACE=/tmp/clan-ui-ws          # 与服务端启动时同一个工作区
node workshop/server/server.mjs &             # 或在别处起，端口默认 8765
python3 tests/server-contract.py
```

如果 **8765 上已经跑着别的服务**（比如你正在用的工坊），测试服务会顺延到 8766 起，
那就要把地址一并指过去，否则脚本会打到那个服务上：

```sh
export DIY_BASE=http://127.0.0.1:8766
```

脚本**自己建夹具**（`<工作区>/扩展源码/测试包/`，含 `info.json` 与一张拷自
`tests/samples/testgood/tg_hero.png` 的图片）—— 有两条断言要靠它：
「新建同名扩展 → 409 冲突」得先扫到这个包，「工作区内图片 → 200」得读到它下面的 png。
**不要手动清掉这个目录**，也不要假设工作区本来就带它（2026-10-12 之前它没自建，
照本文档直接跑会出 2 条假失败）。

脚本开头还会先问一下 `/api/health`，**自检服务与本脚本用的是不是同一个工作区**：
服务端的默认工作区是「启动时的工作目录」，脚本默认 `/tmp/clan-ui-ws`，两边不一样时
脚本会去另一个目录读 `latest-request.json`，报出一堆对不上号的假失败。遇到这种情况，
脚本会直接停下并告诉你怎么改（`export DIY_WORKSPACE=<同一目录>` 后再起服务）。

覆盖：扩展名清洗（斜杠/反斜杠/冒号/井号/百分号/点点/保留名）、重名冲突、
字段规范化（类型白名单、台词去空、路径越界剔除、皮肤同名去重与变身名截断、
**完全空的技能卡剔除**）、空值不落键、非法 JSON、路径穿越、
只读接口（/api/avatar、/api/extension-characters、/api/extensions）、
**卡面识别（/api/card-source 收图与裁块键名过滤、/api/card-import 取回）**。

## 三、前端功能（需要服务在跑 + 无头 Chrome）

> **别拿正式工作区跑这一层**：里面有两条「真实端到端提交」用例，会写
> `<工作区>/.diy-workshop/latest-request.json` —— 在正式工作区上跑就等于把用户刚填的
> 表单覆盖掉（2026-10-15 真踩过一次）。跑之前请用 `DIY_WORKSPACE=/tmp/xxx` 起服务。
> 现在多了一道保险：开跑前问 `/api/health`，工作区里已有提交就自动跳过那两条。

在**真实浏览器**里驱动**真实页面**，63 个用例、**201** 条断言（2026-10-18 实测：201 通过 / 0 失败；
工作区里**已有提交**时，两条真实提交用例自动跳过，各只留 1 条提示 → 断言数降到 **198**）。
覆盖表单、技能增删折叠、皮肤、配音、立绘裁剪、三种扩展目标模式、边界校验、真实端到端提交、
识别卡面（面板展开收起 / 选图启用条件 / 结果只填空白项）、官方包两级下拉与搜索、
**从工作区直接选已有扩展**（不用找 zip）。

测试页必须能被服务 serve，而服务只 serve `workshop/`，所以跑之前先拷进去：

```sh
cp tests/ui/functest.html workshop/_functest.html
/host/opt/google/chrome/chrome --headless=new --no-sandbox --disable-gpu \
  --virtual-time-budget=280000 --dump-dom \
  "http://127.0.0.1:8765/_functest.html" \
  | python3 -c "import sys,re,html;s=sys.stdin.read();m=re.search(r'<pre id=\"log\">(.*?)</pre>',s,re.S);print(html.unescape(m.group(1)) if m else '未取到日志')"
/bin/rm -f workshop/_functest.html            # 跑完清掉
```

Chrome 路径按本机装的位置改（`which chrome` / `chromium`）。

### 已发生过的问题（写测试时必看）

- **结果要写进外层文档**：`--dump-dom` 只给主 frame，写进 iframe 里读不到。
  所以结果是主文档的 `<pre id="log">`，被测页面挂在 iframe 里。
- **假 fetch 用完要还原**：`installFetchSpy` 之后若不 `restoreFetch`，
  后面所有用例都在打假接口 —— 表现是「上传解析返回空」这种假故障。
  已发生过：一次忘了还原，10.1 / 10.2 / 12.1 三条一起假失败。
- **异步等载入不要用固定 tick**：图片解码、FileReader、`canvas.toBlob` 都是异步的，
  机器忙时固定等待会不够（服务端刚重启那轮立绘就没赶上）。用 `waitFor(条件, 次数, 间隔)` 轮询。
- **`.reveal` / 入场动画**：页面靠 rAF 揭示内容，无头下不跑，得在探针里
  手动 `classList.add("is-in")` 并 `animation:none`，否则截出来是纸色底。
- **媒体查询判的是 iframe 宽度**：改 iframe 宽就等于改断点，一套探针能跑完多档。

## 已知的「不是 bug」

- 提交时若体力 > 上限，`hpFieldText()` 会把上限抬到体力（引擎会压回去，
  见 `player.js` 的 `$update()`），并在页面提示 —— 这是有意为之，不是静默改数。
