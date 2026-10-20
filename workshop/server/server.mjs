#!/usr/bin/env node
/**
 * 无名杀 · DIY 工坊 —— 本地服务
 * ============================================================================
 * 它干什么：
 *   把工坊页面发出去，并接收页面提交的设定 —— 落成
 *   `<工作区>/.diy-workshop/latest-request.json`，对话里的 AI 接着读它干活。
 *   另外负责「修改已有」的读包（上传的 zip / 文件夹就地解析、读完即删）
 *   与立绘的存取。
 *
 * 只用 Node 内置模块，零依赖。
 * ==========================================================================*/

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	listExtensions,
	listOfficialPacks,
	readExtensionCharacters,
	readExtensionCharactersAt,
	readOfficialPack,
} from "./extension-reader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSHOP_ROOT = resolve(__dirname, ".."); /* workshop/ */
/* 本 skill 的根目录：references/ 与 scripts/ 都在这里 */
const SKILL_ROOT = resolve(WORKSHOP_ROOT, "..");

/* 工作区：AI 写扩展的地方，也是页面提交后产物的落脚处。
 * 工坊现在装在 skill 目录里，所以【不能】再靠"上一级"来推断工作区 ——
 * 优先读 DIY_WORKSPACE 环境变量，其次用启动时的工作目录。 */
const WORKSPACE = resolve(process.env.DIY_WORKSPACE || process.cwd());
/* 候选端口：默认 8765，被占用就依次往后试。
 * 选的都是不常被占的号段（避开 3000 / 5000 / 8000 / 8080 这些开发常用口）。
 * 显式设了 DIY_PORT 就只用它、不再回退 —— 以免误以为指定了端口、实际却跑在别的端口上。 */
const PORT_CANDIDATES = process.env.DIY_PORT
	? [Number(process.env.DIY_PORT)]
	: [8765, 8766, 8767, 18765, 18766, 28765];

/* 实际监听成功的端口，listen 之后才有确定值 */
let PORT = PORT_CANDIDATES[0];

/* 立绘等运行期产物：放在工作区内的隐藏目录，不污染扩展源码 */
const TMP_DIR = join(WORKSPACE, ".diy-workshop");

const MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

function log(...args) {
	console.log(`[${new Date().toLocaleTimeString("zh-CN")}]`, ...args);
}

/* ── 静态资源 ──────────────────────────────────────────────────────────── */
async function serveStatic(res, urlPath) {
	const rel = urlPath === "/" ? "/index.html" : urlPath;
	const full = normalize(join(WORKSHOP_ROOT, rel));

	/* 目录穿越防护：只允许工坊目录内的文件 */
	if (!full.startsWith(WORKSHOP_ROOT)) {
		res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
		res.end("禁止访问工坊目录之外的文件");
		return;
	}

	try {
		let data = await readFile(full);
		const ext = extname(full).toLowerCase();

		/* 给页面里的 css / js 引用自动带上 `?v=<文件修改时间>`。
		 *
		 * 为什么需要：`cache-control: no-cache` 只让浏览器「用之前问一下」，
		 * 但页面开着不刷新时它连问都不问 —— 改完样式用户看不到变化，
		 * 只能按 Ctrl+F5，这个坑实际踩过（用户反馈「还是没变」）。
		 *
		 * 用文件 mtime 当版本号：改过的文件 URL 变了 → 浏览器必然重新下载；
		 * 没改的文件版本号不变 → 缓存照常命中，不会每次都重传。 */
		if (ext === ".html") {
			let html = data.toString("utf8");
			const refs = [...html.matchAll(/(href|src)="((?:styles|scripts)\/[^"?]+)(\?[^"]*)?"/g)];
			for (const m of refs) {
				const st = await stat(join(WORKSHOP_ROOT, m[2])).catch(() => null);
				if (!st) continue;
				const v = Math.round(st.mtimeMs).toString(36);
				html = html.replace(m[0], `${m[1]}="${m[2]}?v=${v}"`);
			}
			data = Buffer.from(html, "utf8");
		}

		res.writeHead(200, {
			"content-type": MIME[ext] || "application/octet-stream",
			"cache-control": "no-cache",
		});
		res.end(data);
	} catch {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("找不到：" + rel);
	}
}

function readJson(req) {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
			/* 立绘 dataURL 可能几百 KB，给足空间但不要无限 */
			if (raw.length > 24 * 1024 * 1024) reject(new Error("请求体过大"));
		});
		req.on("end", () => {
			try {
				resolve(raw ? JSON.parse(raw) : {});
			} catch (e) {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}


/*
 * 跨平台「child 是否在 parent 里面」判断。
 * 不能写 parent + "/" 前缀比较 —— Windows 的 resolve() 返回的是反斜杠路径，
 * 那样判断会永远失败（表现为上传文件夹被判越权）。
 */
function isInside(parent, child) {
	const rel = relative(resolve(parent), resolve(child));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/*
 * 挑一个可用的 Python 命令。
 * Windows 官方安装器只提供 python.exe 与 py.exe，**没有 python3.exe**；
 * Linux / macOS 则通常只有 python3。写死任何一个都会在另一种平台上失败。
 * 可用环境变量 DIY_PYTHON 手动指定。
 */
let PYTHON_CMD = null;
async function resolvePython() {
	if (PYTHON_CMD) return PYTHON_CMD;

	if (process.env.DIY_PYTHON) {
		PYTHON_CMD = process.env.DIY_PYTHON;
		log(`[环境] Python 命令：${PYTHON_CMD}（来自 DIY_PYTHON）`);
		return PYTHON_CMD;
	}

	for (const cmd of ["python3", "python", "py"]) {
		const ok = await new Promise((done) => {
			execFile(cmd, ["--version"], { timeout: 5000, windowsHide: true }, (err) => done(!err));
		});
		if (ok) {
			PYTHON_CMD = cmd;
			log(`[环境] Python 命令：${cmd}`);
			return PYTHON_CMD;
		}
	}
	throw new Error(
		"没找到 Python（试过 python3 / python / py）。请安装 Python 3，" +
			"或用环境变量 DIY_PYTHON 指定解释器路径。",
	);
}

/* 在解压出来的目录里找 extension.js 所在层（最多往下找两层） */
async function findExtensionRoot(base, depth = 0) {
	if (existsSync(join(base, "extension.js"))) return base;
	if (depth >= 2) return null;
	const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
	for (const e of entries) {
		if (!e.isDirectory() || e.name.startsWith("__")) continue;
		const found = await findExtensionRoot(join(base, e.name), depth + 1);
		if (found) return found;
	}
	return null;
}

/* 统一的 JSON 响应 */
function json(res, code, body) {
	res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

/* 找扩展目录。工坊默认把产物写在工作区的「扩展源码」下，但 AI 也可能
 * 直接写进游戏包的 resources/app/extension。游戏包名带版本号，所以往下
 * 扫两层去认，不写死路径 —— 否则会因为口径不一致而静默跳过检查。 */
async function findExtensionDir(name) {
	const direct = join(WORKSPACE, "扩展源码", name);
	if (existsSync(direct)) return direct;

	const tops = await readdir(WORKSPACE, { withFileTypes: true }).catch(() => []);
	for (const top of tops) {
		if (!top.isDirectory()) continue;
		const pkgRoot = join(WORKSPACE, top.name);
		const inners = await readdir(pkgRoot, { withFileTypes: true }).catch(() => []);
		for (const inner of inners) {
			if (!inner.isDirectory()) continue;
			const guess = join(pkgRoot, inner.name, "resources", "app", "extension", name);
			if (existsSync(guess)) return guess;
		}
	}
	return null;
}

/* 上传的扩展在工作区里的落地目录名：去掉路径分隔符与文件系统不友好的字符 */
function safeFolderName(name) {
	const cleaned = String(name || "")
		.replace(/[\\/:*?"<>|#%]/g, "_")
		.trim();
	return cleaned || "upload";
}

/* 配音：单个文件上限。前端也卡同样的值（`main.js` 的 AUDIO_MAX_BYTES）——
 * 音频会跟着扩展一起分发，放几十 MB 进去会让扩展无法分发。 */
const AUDIO_MAX_BYTES = 5 * 1024 * 1024;
const AUDIO_MAX_MB = Math.round(AUDIO_MAX_BYTES / 1024 / 1024);

/* 皮肤图上限：前端已经裁到 350×464 的 jpeg，正常一张 30~60KB。
 * 给 2MB 的余量，既能挡住误传原始大图，又不会卡住正常用法。 */
const SKIN_MAX_BYTES = 2 * 1024 * 1024;
const SKIN_MAX_MB = Math.round(SKIN_MAX_BYTES / 1024 / 1024);

/* 国战里认的势力：五种（晋随江山如故类玩法进国战，但 lib.group 默认就含它，
 * 见引擎 `lib.group` 的定义）。武将平时的「神 / 自定义」不在此列 ——
 * 那正是「国战归属」这个字段要解决的问题。 */
const GUOZHAN_GROUPS = new Set(["wei", "shu", "wu", "qun", "jin"]);

/* 台词：一行一句的纯文本列表 —— 只留非空字符串。
 * 引擎把每句存成 `lib.translate["#<地址>N"]`（技能）或 `#<地址>N:die`（阵亡），
 * 规则见规范 8.1。 */
function normalizeLines(raw) {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((s) => String(s == null ? "" : s).trim())
		.filter((s) => s !== "");
}

/* 技能只留 name / desc / lines（可选）——
 * 前端还带着 `sample`（那张「示例位」的标记）这类界面用字段，不进交付文件。 */
function normalizeSkills(raw) {
	if (!Array.isArray(raw)) return [];
	/* 技能类型勾选 → 落盘字段（映射规则见规范 5.2）：
	 * locked 要 AI 同时写 forced；limited 引擎自动补 mark/动画；juexingji/zhuanhuanji
	 * 只给标签、效果照写；zhuSkill 主公技；clanSkill 宗族技（要求角色写 clans）。 */
	const FLAGS = new Set(["locked", "limited", "juexingji", "zhuanhuanji", "zhuSkill", "dutySkill", "clanSkill"]);
	const out = [];
	for (const s of raw) {
		const skill = {
			name: String((s && s.name) || ""),
			desc: String((s && s.desc) || ""),
		};
		const types = Array.from(
			new Set((Array.isArray(s && s.types) ? s.types : []).map((t) => String(t || "").trim()).filter((t) => FLAGS.has(t))),
		);
		if (types.length) skill.types = types;
		const lines = normalizeLines(s && s.lines);
		if (lines.length) skill.lines = lines;
		/* 补充说明：用户对效果细节的补充（使命成败/觉醒条件/转换两态/技能变身时机/
		 * 动态显示/数值细节……），AI 按内容落到对应机制（动态显示走 7.9）。限 800 字。 */
		const notes = String((s && s.notes) || "").trim().slice(0, 800);
		if (notes) skill.notes = notes;
		/* 配音路径：前端上传后回填的绝对路径，第 n 个 = 第 n 句台词。
		 * **只认本工作区内的音频文件** —— 前端给什么就收什么，
		 * 等于让 AI 去读任意路径的文件。 */
		const audio = Array.isArray(s && s.audioFiles) ? s.audioFiles : [];
		const safeAudio = audio.filter(
			(p) =>
				typeof p === "string" &&
				isInside(WORKSPACE, p) &&
				/\.(?:mp3|m4a|ogg|wav|aac|flac)$/i.test(p),
		);
		if (safeAudio.length) skill.audioFiles = safeAudio;

		/* 一整张都没填的技能卡不进交付。
		 * 起手给的是两张「示例位」卡（`addSkill("", "", true)`），用户常常只填一张 ——
		 * 另一张原样留着。若不剔除，AI 会收到 {"name":"","desc":""}，
		 * 当成「用户还想要一个技能但没写」，于是凭空补一个出来。
		 *
		 * 判断放在**这里**而不是前端，有两个原因：
		 *  ① 交付物是这份落盘 JSON 定型的，前端只管收集；
		 *  ② 前端 `uploadAudioForSkills` 是拿「技能块下标」去索引 payload.skills[i]，
		 *     前端一旦压缩数组就会错位 —— 第 1 张空、第 2 张有配音时，配音会挂丢。
		 * 所以前端保留全量（下标一一对应），空壳在这里剔除。
		 * 注意 audioFiles 是判断的一部分：只有配音、没写字的卡是用户真意图，不能丢。 */
		const isEmpty =
			!skill.name && !skill.desc && !skill.types && !skill.lines && !skill.notes && !skill.audioFiles;
		if (isEmpty) continue;
		out.push(skill);
	}
	return out;
}

/* 皮肤形态：只要 { name, path } 两个字段，别的丢掉。
 * 路径必须落在本工作区内 —— 与技能配音同一个道理：handoff 是个中转站，
 * 不是"顺着任意路径读文件"的通道。
 * 顺带把重名处理掉：形态名就是最终文件名，同名会让后面那张覆盖前面那张。 */
function normalizeSkins(raw) {
	if (!Array.isArray(raw)) return [];
	const seen = new Set();
	const out = [];
	for (const s of raw) {
		const name = String((s && s.name) || "").trim();
		const p = s && s.path;
		if (!name) continue;
		if (typeof p !== "string" || !isInside(WORKSPACE, p)) continue;
		if (!/\.(?:jpe?g|png|webp)$/i.test(p)) continue;
		if (seen.has(name)) continue;
		seen.add(name);
		const skin = { name: name, path: p };
		/* 变身名：皮肤路线 B（技能变身）时玩家牌上显示的名字。
		 * 原样保留 —— 它是翻译值，中文名直接可用。 */
		const tempname = String((s && s.tempname) || "").trim();
		if (tempname) skin.tempname = tempname.slice(0, 20);
		out.push(skin);
	}
	return out;
}

/* 游戏自带的保留名：与官方武将包同名时引擎**不报错**，而是对已存在的
 * `lib.characterPack[名字]` 做 Object.assign 静默合并（见引擎 init/loading.js），
 * 自制武将就混进「标准包」里了；与玩法同名则会被当原生扩展拒装。
 * 游戏包名带版本号，和 findExtensionDir 一样往下扫两层认。 */
async function collectReservedNames() {
	const names = new Set(["boss", "cardpile", "coin"]); /* 官方玩法（stockextension） */
	const tops = await readdir(WORKSPACE, { withFileTypes: true }).catch(() => []);
	for (const top of tops) {
		if (!top.isDirectory()) continue;
		const pkgRoot = join(WORKSPACE, top.name);
		const inners = await readdir(pkgRoot, { withFileTypes: true }).catch(() => []);
		for (const inner of inners) {
			if (!inner.isDirectory()) continue;
			const charDir = join(pkgRoot, inner.name, "resources", "app", "character");
			const files = await readdir(charDir).catch(() => []);
			for (const f of files) {
				if (f.endsWith(".js")) names.add(f.slice(0, -3));
			}
		}
	}
	return names;
}

/* ── HTTP 路由 ─────────────────────────────────────────────────────────── */
const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const path = url.pathname;

	/* 已有扩展列表：供「修改已有」模式选扩展 */
	if (path === "/api/extensions") {
		try {
			const list = await listExtensions(WORKSPACE);
			/* `path` 也一起给出去：「修改已有」要拿它当 `uploadPath` 交给 AI，
			 * AI 才知道就地改哪个目录。没有它前端就只能让用户自己找 zip。
			 * 游戏包里那份也会列出来（origin = 「游戏包」），但前端要先走
			 * /api/import-extension 复制成副本 —— 游戏本体只读。 */
			json(res, 200, {
				ok: true,
				extensions: list.map(({ name, origin, path: dir }) => ({ name, origin, path: dir })),
			});
		} catch (e) {
			json(res, 500, { error: `扫描扩展失败：${e.message}` });
		}
		return;
	}

	/* 把游戏包里的扩展**复制一份**到工作区（「修改已有」要改游戏里那份时用）。
	 *
	 * 为什么不是直接改：游戏本体是只读的（红线）。所以先复制到
	 * `扩展源码/<名字>/`（重名就加 -副本 后缀），之后所有改动都落在副本上。
	 * 源只认 `listExtensions` 扫出来的结果，**不接受前端传路径** —— 防越权。 */
	if (path === "/api/import-extension" && req.method === "POST") {
		let form;
		try {
			form = await readJson(req);
		} catch (e) {
			json(res, 400, { error: e.message });
			return;
		}
		const want = String(form.name || "").trim();
		if (!want) {
			json(res, 400, { error: "缺 name 参数" });
			return;
		}
		try {
			const list = await listExtensions(WORKSPACE);
			const found = list.find((x) => x.name === want);
			if (!found) {
				json(res, 404, { error: `找不到扩展「${want}」` });
				return;
			}
			/* 本来就在工作区里 → 直接用，不必复制 */
			if (found.origin === "工作区") {
				json(res, 200, { ok: true, name: found.name, path: found.path, copied: false });
				return;
			}
			const base = join(WORKSPACE, "扩展源码");
			await mkdir(base, { recursive: true });
			let target = join(base, found.name);
			let n = 0;
			while (existsSync(target)) {
				n++;
				target = join(base, `${found.name}-副本${n > 1 ? n : ""}`);
			}
			await cp(found.path, target, { recursive: true });
			log("[reader] 从游戏包复制扩展", want, "→", target);
			json(res, 200, { ok: true, name: basename(target), path: target, copied: true });
		} catch (e) {
			json(res, 500, { error: `复制扩展失败：${e.message}` });
		}
		return;
	}

	/* 官方包列表 —— 拿来**当模板**用（官方武将不能改，只能照着做自己的）。
	 * 只扫游戏自带的 character/，不碰第三方 extension/（UI 美化、特效美化在那）。
	 * 读不出武将的条目不列，"是不是武将包"用数据说话。 */
	if (path === "/api/official-packs") {
		try {
			const packs = await listOfficialPacks(WORKSPACE);
			log("[reader] 官方包", packs.length, "个");
			json(res, 200, { ok: true, packs });
		} catch (e) {
			json(res, 500, { error: `扫描官方包失败：${e.message}` });
		}
		return;
	}

	/* 读一个官方包的武将：填进表单当模板。返回形状与 /api/extension-characters 一致，
	 * 前端那套回填逻辑可以复用；额外带 readonly 标记，提醒"只能另建扩展"。 */
	if (path === "/api/official-characters") {
		const pack = String(url.searchParams.get("pack") || "").trim();
		/* 包名进过路径拼接，必须收紧 —— 别让人从这儿走 ../ 出去 */
		if (!pack || !/^[\w\u4e00-\u9fff.-]+$/.test(pack) || pack.includes("..")) {
			json(res, 400, { error: "包名不合法" });
			return;
		}
		try {
			const data = await readOfficialPack(WORKSPACE, pack);
			if (!data) {
				json(res, 404, { error: `找不到官方包「${pack}」` });
				return;
			}
			log("[reader] 读官方包", pack, "→", data.characters.length, "个武将");
			json(res, 200, {
				ok: true,
				name: data.name,
				label: data.label,
				source: "official",
				readonly: true,
				characters: data.characters,
			});
		} catch (e) {
			json(res, 500, { error: `读官方包失败：${e.message}` });
		}
		return;
	}

	/* 某个扩展里的武将（含技能描述与头像路径） */
	if (path === "/api/extension-characters") {
		const want = String(url.searchParams.get("name") || "").trim();
		if (!want) {
			json(res, 400, { error: "缺 name 参数" });
			return;
		}
		try {
			const data = await readExtensionCharacters(WORKSPACE, want);
			if (!data) {
				json(res, 404, { error: `找不到扩展「${want}」` });
				return;
			}
			log("[reader] 读扩展", want, "→", data.characters.length, "个武将");
			json(res, 200, {
				ok: true,
				name: data.name,
				characters: data.characters,
				/* 扩展包介绍（整包级，来自那个包的 info.json） */
				intro: data.intro || "",
			});
		} catch (e) {
			json(res, 500, { error: `读扩展失败：${e.message}` });
		}
		return;
	}

	/* 读一张图片（立绘原图）。只允许读工作区内的图片文件，防路径穿越。 */
	if (path === "/api/avatar") {
		const raw = String(url.searchParams.get("path") || "");
		const target = resolve(raw);
		if (!isInside(WORKSPACE, target) || !/\.(?:jpe?g|png|webp|gif)$/i.test(target)) {
			json(res, 403, { error: "只允许读工作区内的图片" });
			return;
		}
		if (!existsSync(target)) {
			json(res, 404, { error: "图片不存在" });
			return;
		}
		try {
			const buf = await readFile(target);
			const ext = extname(target).toLowerCase();
			const mime =
				ext === ".png" ? "image/png" :
				ext === ".webp" ? "image/webp" :
				ext === ".gif" ? "image/gif" : "image/jpeg";
			res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
			res.end(buf);
		} catch (e) {
			json(res, 500, { error: e.message });
		}
		return;
	}

	/*
	 * 接收上传的扩展并解析它的武将。
	 * 两种来源：kind="zip" 传一个 zip 的 base64；kind="dir" 传文件数组。
	 * 统一解到临时目录再交给 extension-reader 解析，读完即删。
	 */
	if (path === "/api/read-upload" && req.method === "POST") {
		let body;
		try {
			body = await readJson(req);
		} catch (e) {
			json(res, 400, { error: e.message });
			return;
		}

		const stamp = randomUUID().slice(0, 8);
		const workDir = join(WORKSPACE, ".diy-workshop", `upload-${stamp}`);
		let unpackedRoot = null;

		try {
			await mkdir(workDir, { recursive: true });

			if (body.kind === "zip" && body.data) {
				const zipPath = join(workDir, "__upload.zip");
				await writeFile(zipPath, Buffer.from(body.data, "base64"));
				/* 用 skill 自带的解压脚本：不依赖系统的 unzip，
				 * 并且它会顺手把「扩展根在哪一层」也定出来。 */
				const unpackScript = join(SKILL_ROOT, "scripts", "unpack-extension.py");
				await resolvePython();
				/* 脚本会把「扩展根」打印成最后一行，直接拿它用 ——
				 * 免得服务端再写一套找根逻辑，两边判断不一致。 */
				unpackedRoot = await new Promise((resolve, reject) => {
					execFile(
						PYTHON_CMD,
						[unpackScript, zipPath, join(workDir, "x")],
						(err, stdout, stderr) => {
							if (err) {
								reject(new Error("解压失败：" + (stderr || err.message).trim()));
								return;
							}
							const m = /^扩展根：(.*)$/m.exec(String(stdout || ""));
							resolve(m ? m[1].trim() : null);
						},
					);
				});
			} else if (body.kind === "dir" && Array.isArray(body.files)) {
				for (const f of body.files) {
					/* 防路径穿越：只允许落在 workDir 内 */
					const rel = String(f.path || "").replace(/^\.\//, "");
					const target = resolve(workDir, rel);
					if (!isInside(workDir, target)) continue;
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, Buffer.from(f.data || "", "base64"));
				}
			} else {
				json(res, 400, { error: "没收到压缩包或文件列表" });
				return;
			}

			/* 压缩包走脚本时它已经算好了根；文件夹上传才需要自己找 */
			const root = unpackedRoot || (await findExtensionRoot(workDir));
			if (!root) {
				json(res, 422, { error: "这个包里没找到 extension.js，确认是扩展包而不是别的 zip" });
				return;
			}

			const data = await readExtensionCharactersAt(root);

			/* 立绘必须复制出来再删临时目录 —— 否则前端拿到的路径指向
			 * 一个已被删掉的目录，表现是「选了武将但没有立绘」。
			 * 复制到工作区的 .diy-workshop/uploaded-art/，下次上传覆盖。 */
			const artDir = join(TMP_DIR, "uploaded-art");
			/* 每次上传前清空：换一个扩展包时，旧包的立绘留着没用还占地方 */
			await rm(artDir, { recursive: true, force: true }).catch(() => {});
			await mkdir(artDir, { recursive: true });
			let copied = 0;
			for (const c of data.characters) {
				if (!c.avatar) continue;
				try {
					const target = join(artDir, c.id + extname(c.avatar));
					await copyFile(c.avatar, target);
					c.avatar = target;
					copied++;
				} catch {
					/* 单张图失败不影响其他 */
					c.avatar = null;
				}
			}

			log(
				"[upload] 解析上传的扩展", body.name || "", "→",
				data.characters.length, "个武将，立绘", copied, "张",
			);
			/* 包名用上传时的名字 —— 解压目录是内部名，对用户没意义 */
			const displayName = String(body.name || "").replace(/\.zip$/i, "") || basename(root);

			/* **把扩展留在工作区里**：AI 要拿它当落点 —— 「加入已有」往里追加武将、
			 * 「修改已有」就地改字段。原先解析完即删，导致 AI 手里只有个包名
			 * （审计 2026-10-10 发现的两个断点）。目录名用扩展名，重传同一包直接覆盖。 */
			const keepDir = join(TMP_DIR, "uploaded", safeFolderName(displayName));
			await rm(keepDir, { recursive: true, force: true }).catch(() => {});
			await mkdir(dirname(keepDir), { recursive: true });
			await cp(root, keepDir, { recursive: true });

			json(res, 200, {
				ok: true,
				name: displayName,
				root: keepDir,
				characters: data.characters,
				/* 扩展包介绍（整包级）—— 前端读出来填进表单给用户看/改 */
				intro: data.intro || "",
				unreadable: data.unreadable,
			});
		} catch (e) {
			json(res, 500, { error: e.message });
		} finally {
			/* 解析完就删，不要在工作区堆积 */
			await rm(workDir, { recursive: true, force: true }).catch(() => {});
		}
		return;
	}

	/* 健康检查：页面用它确认本地服务在跑、并探出实际端口。
	 * 同时报出「工作区里是否已经有别人提交的表单」—— 前端测试拿它决定
	 * 要不要跑"真实提交"那两条用例：真提交会写 latest-request.json，
	 * 在正式工作区上跑就会把用户刚填的东西覆盖掉（2026-10-15 真踩过）。 */
	if (path === "/api/health") {
		const hasSubmit = existsSync(join(WORKSPACE, ".diy-workshop", "latest-request.json"));
		res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: true, workspace: WORKSPACE, port: PORT, hasSubmit }));
		return;
	}

	/* 把表单交给「对话里的 AI」。
	 * 工坊页面只负责收集，落成一份 JSON（立绘单独存文件、JSON 里记路径），
	 * 用户回到 AI 对话窗口后，AI 读这个文件接着干 —— 歧义也在那边问。 */
	/* 技能配音上传：前端把 mp3 读成 dataURL 发过来，这里**原样**落盘到工作区，
	 * 返回绝对路径 —— handoff 的 JSON 里只记路径（mp3 塞进去会把它撑爆）。
	 * 音频不做任何转码：转了只会掉音质。 */
	if (path === "/api/audio" && req.method === "POST") {
		let body;
		try {
			body = await readJson(req);
		} catch (e) {
			json(res, 400, { error: e.message });
			return;
		}
		const m = /^data:audio\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(body.data || ""));
		if (!m) {
			json(res, 400, { error: "这不是音频文件（只收 mp3 / m4a / ogg / wav 这类）" });
			return;
		}
		const buf = Buffer.from(m[2], "base64");
		if (!buf.length) {
			json(res, 400, { error: "音频是空的" });
			return;
		}
		if (buf.length > AUDIO_MAX_BYTES) {
			json(res, 413, { error: `音频超过 ${AUDIO_MAX_MB}MB，先压一下再传` });
			return;
		}
		try {
			const dir = join(TMP_DIR, "audio");
			await mkdir(dir, { recursive: true });
			const rawExt = m[1].toLowerCase();
			const ext = rawExt === "mpeg" ? "mp3" : rawExt === "x-m4a" ? "m4a" : rawExt;
			const stem = safeFolderName(String(body.name || "audio").replace(/\.[^.]+$/, ""));
			const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			const target = join(dir, `${stem}-${stamp}.${ext}`);
			await writeFile(target, buf);
			log("[audio] 收到配音", body.name || "", "→", `${Math.round(buf.length / 1024)}KB`);
			json(res, 200, { ok: true, path: target });
		} catch (e) {
			json(res, 500, { error: `存音频失败：${e.message}` });
		}
		return;
	}

	/* 皮肤图上传：和配音一个思路 —— 前端先把图裁成 350×464 的 jpeg dataURL 发过来，
	 * 这里原样落盘返回路径，handoff 的 JSON 里只记路径。
	 * 不做二次压缩：前端已经压过一道（jpeg 0.92），再压只会掉画质。 */
	if (path === "/api/skin" && req.method === "POST") {
		let body;
		try {
			body = await readJson(req);
		} catch (e) {
			json(res, 400, { error: e.message });
			return;
		}
		const m = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(body.data || ""));
		if (!m) {
			json(res, 400, { error: "这不是图片文件（要 jpg / png 这类）" });
			return;
		}
		const buf = Buffer.from(m[2], "base64");
		if (!buf.length) {
			json(res, 400, { error: "这张图是空的" });
			return;
		}
		if (buf.length > SKIN_MAX_BYTES) {
			json(res, 413, { error: `这张图超过 ${SKIN_MAX_MB}MB，先压一下再传` });
			return;
		}
		try {
			const dir = join(TMP_DIR, "skin");
			await mkdir(dir, { recursive: true });
			/* 形态名**原样保留**（中文也没关系）—— 它在游戏里是玩家看到的皮肤名，
			 * 引擎取的是文件名去扩展名。只把文件系统不收的字符换掉。 */
			const stem = safeFolderName(String(body.name || "skin")).slice(0, 24);
			const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			const target = join(dir, `${stem}-${stamp}.jpg`);
			await writeFile(target, buf);
			log("[skin] 收到皮肤图", `${stem}.jpg`, "→", `${Math.round(buf.length / 1024)}KB`);
			json(res, 200, { ok: true, path: target });
		} catch (e) {
			json(res, 500, { error: `存皮肤图失败：${e.message}` });
		}
		return;
	}

	/* ── 卡面识别：页面把「卡面图 + 裁好的块 + 立绘图」落盘，交给对话里的 AI ──
	 * 数据流是**单向落盘 + 轮询**，不引入任何长连接：
	 *   页面 POST 这里 → 写 card-source.json
	 *   → 用户回对话说一声 → AI 读那些图识别 → 写 card-import.json
	 *   → 页面 GET /api/card-import 取回并回填表单。
	 * 之所以不让 AI 直接写 latest-request.json：那个文件代表「用户提交的表单」，
	 * 两件事混在一个文件里，页面就无法判断这次变化是自己提交的还是 AI 回填的。 */
	if (path === "/api/card-source" && req.method === "POST") {
		let body;
		try {
			body = await readJson(req);
		} catch (e) {
			json(res, 400, { error: e.message });
			return;
		}

		const dir = join(TMP_DIR, "card");
		const saved = {};
		let total = 0;

		/* 只收 dataURL 形式的图片；键名限死成安全字符，免得被当路径用 */
		const put = async (key, val) => {
			if (typeof val !== "string") return;
			const m = /^data:image\/([a-z]+);base64,(.+)$/i.exec(val);
			if (!m) return;
			const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
			const buf = Buffer.from(m[2], "base64");
			total += buf.length;
			await writeFile(join(dir, `${key}.${ext}`), buf);
			saved[key] = join(dir, `${key}.${ext}`);
		};

		try {
			/* 先清空上一轮的图再写 —— 否则这次只传了新卡面，目录里还留着上张卡的
			 * 裁块，AI 若按目录列表读就会把两张卡的图混在一起认。 */
			await rm(dir, { recursive: true, force: true });
			await mkdir(dir, { recursive: true });
			await put("card", body.card);
			await put("art", body.art);
			const parts = body.parts && typeof body.parts === "object" ? body.parts : {};
			for (const k of Object.keys(parts)) {
				if (!/^[a-z][a-z0-9]{0,15}$/i.test(k)) continue;
				await put(`part-${k}`, parts[k]);
			}
			if (!saved.card && !saved.art) {
				json(res, 400, { error: "没收到图（卡面或立绘至少要一张）" });
				return;
			}

			/* 换了新卡面就把上一轮的识别结果**挪走**（`card-import.prev.json`），不直接删。
			 * 不挪的话页面轮询会立刻读回旧结果，看起来像「识别错了」；
			 * 但直接删会让 AI 刚写的结果凭空消失 —— 2026-10-17 实测踩过：
			 * 「让用户重新上传一次」这个救场动作，反而把刚写好的结果删了。 */
			const prevResult = join(TMP_DIR, "card-import.json");
			if (existsSync(prevResult)) {
				await rm(join(TMP_DIR, "card-import.prev.json"), { force: true }).catch(() => {});
				await rename(prevResult, join(TMP_DIR, "card-import.prev.json")).catch(() => {});
				log("[card] 上一轮识别结果已备份为 card-import.prev.json");
			}

			const partsSaved = {};
			for (const [k, v] of Object.entries(saved)) {
				if (k.startsWith("part-")) partsSaved[k.slice(5)] = v;
			}
			const source = {
				requestedAt: new Date().toISOString(),
				card: saved.card,
				art: saved.art || null,
				parts: partsSaved,
				cardSize: body.cardSize || null,
				note: "AI 读完这些图后，把识别结果写到同目录的 card-import.json",
			};
			await writeFile(join(TMP_DIR, "card-source.json"), JSON.stringify(source, null, 2), "utf-8");
			log("[card] 收到卡面", `${Math.round(total / 1024)}KB`, Object.keys(saved).join(", "));
			json(res, 200, { ok: true, dir, saved, parts: partsSaved });
		} catch (e) {
			json(res, 500, { error: `存卡面失败：${e.message}` });
		}
		return;
	}

	/* 页面每 3 秒问一次「AI 写好识别结果没有」。只读接口，没有就 404。 */
	if (path === "/api/card-import") {
		try {
			const text = await readFile(join(TMP_DIR, "card-import.json"), "utf-8");
			res.writeHead(200, {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "no-store",
			});
			res.end(text);
		} catch {
			json(res, 404, { error: "还没有识别结果" });
		}
		return;
	}

	if (path === "/api/handoff" && req.method === "POST") {
		let form;
		try {
			form = await readJson(req);
		} catch (e) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: e.message }));
			return;
		}

		/* 扩展名会被当作目录名，先挡住非法字符 */
		const extName = String(form.extName || "").trim();
		if (!extName) {
			json(res, 400, { error: "扩展名是空的" });
			return;
		}
		if (/[\\/:*?"<>|]/.test(extName) || extName === "." || extName === "..") {
			json(res, 400, { error: `扩展名「${extName}」含非法字符，换一个（不要用路径分隔符）` });
			return;
		}
		/* 扩展名会被拼进 `import('/extension/<名>/extension.js')` 当 URL 路径段：
		 * `#` 之后会被当片段截断、`%` 会触发 URI 解析错误 —— 整个扩展都加载不到。
		 * （审计 2026-10-10；浏览器 URL 语义推断，源码无显式校验） */
		if (/[#%]/.test(extName)) {
			json(res, 400, { error: `扩展名不要用 # 或 %（这两个字符会让游戏找不到扩展），换一个` });
			return;
		}
		/* 与官方包/玩法同名 → 引擎会静默合并或拒装 */
		if ((await collectReservedNames()).has(extName)) {
			json(res, 400, {
				error: `扩展名「${extName}」是游戏自带的包名（或玩法名），会跟官方内容混在一起。换一个名字。`,
			});
			return;
		}

		/* 只有「新建」才查重 —— 「加入已有」与「修改已有」本来就是针对已存在的扩展。
		 * 之前写成 !== "existing"，导致「修改已有」必然命中冲突被拒。 */
		if ((form.extMode || "new") === "new") {
			const existing = await findExtensionDir(extName);
			if (existing) {
				log("[handoff] 拒绝：扩展已存在", extName, existing);
				json(res, 409, {
					error: `扩展「${extName}」已经存在`,
					conflict: { name: extName, path: existing },
					hint: "把「扩展到」改成「加入已有」来追加武将，或者换一个扩展名。",
				});
				return;
			}
		}

		try {
			await mkdir(TMP_DIR, { recursive: true });

			/* 立绘单独落盘，JSON 里只记路径 */
			let avatarPath = null;
			if (form.avatar && typeof form.avatar === "string" && form.avatar.startsWith("data:image/")) {
				const m = /^data:image\/([a-z]+);base64,(.+)$/i.exec(form.avatar);
				if (m) {
					avatarPath = join(TMP_DIR, `avatar-submitted.${m[1] === "jpeg" ? "jpg" : m[1]}`);
					await writeFile(avatarPath, Buffer.from(m[2], "base64"));
				}
			}

			const payload = {
				submittedAt: new Date().toISOString(),
				extMode: form.extMode || "new",
				extName: form.extName || "",
				name: form.name || "",
				title: form.title || "",
				group: form.group || "", /* 自定义势力时前端留空，以 groupCustom 为准 */
				groupCustom: form.groupCustom || "",
				sex: form.sex || "male",
				/* `4/6` = 体力 4 / 上限 6（引擎原生写法）；只写一个数时两者相同 */
				hp: form.hp || "4/4/0",
				skills: normalizeSkills(form.skills),
				avatarPath,
				workspace: WORKSPACE,
			};

			/* 扩展包介绍（整包级，写进那个扩展的 info.json 的 `intro`）。
			 * **空值时直接不带这个键** —— 否则 AI 可能把空字符串写进 info.json，
			 * 把「加入已有 / 修改已有」那个扩展原有的介绍清掉。 */
			const intro = String(form.intro || "").trim();
			if (intro) payload.intro = intro;

			/* 阵亡台词：一行一句。空则不写这个键 —— 理由同 intro，
			 * 免得 AI 把空数组理解成"要把阵亡台词清掉"。 */
			const dieLines = normalizeLines(form.dieLines);
			if (dieLines.length) payload.dieLines = dieLines;

			/* 皮肤形态：每项 { name, path }。
			 * name 最后就是**玩家在游戏里看到的皮肤名** —— 引擎取文件名去扩展名，
			 * 查不到翻译时原样返回（get.translation 的兜底），
			 * 所以中文名要原样递出去，不能洗成拼音。 */
			const skins = normalizeSkins(form.skins);
			if (skins.length) payload.skins = skins;

			/* 国战：归属与多势力。只认五种内置势力（魏蜀吴群晋）——
			 * 引擎的 `groupInGuozhan` 有一道闸：值必须在 lib.group 里才生效
			 * ，写别的等于白写。 */
			const gz = String(form.guozhanGroup || "").trim();
			if (GUOZHAN_GROUPS.has(gz)) payload.guozhanGroup = gz;
			const dgs = Array.from(
				new Set(
					(Array.isArray(form.doubleGroups) ? form.doubleGroups : [])
						.map((g) => String(g || "").trim())
						.filter((g) => GUOZHAN_GROUPS.has(g)),
				),
			);
			if (dgs.length) payload.doubleGroups = dgs;

			/* 资料页四字段 + 选将包名：整包级 KV，原样转交（trim 后非空才带）。
			 * 与 intro 同一条规矩：payload 里没有的键，AI 不许去动 info.json 里已有的值。 */
			/* 资料页字段 + 选将包名：整包级 KV，原样转交（trim 后非空才带）。
			 * 与 intro 同一条规矩：payload 里没有的键，AI 不许去动 info.json 里已有的值。
			 * 网盘/论坛链接（diskURL/forumURL）已撤掉 —— info.json 六字段仍支持，
			 * 用户想要就在对话里说，AI 直接写。 */
			for (const key of ["author", "version", "packDisplayName"]) {
				const v = String(form[key] || "").trim();
				if (v) payload[key] = v;
			}

			/* 宗族：数组（引擎 clans 就是数组，可归属多个），去空、限长。
			 * 名字原样保留 —— 它要跟宗族技里写的宗族名对得上。 */
			const clans = Array.from(
				new Set(
					(Array.isArray(form.clans) ? form.clans : [])
						.map((c) => String(c || "").trim())
						.filter(Boolean),
				),
			).slice(0, 5);
			if (clans.length) payload.clans = clans;

			/* 武将列传：详情页的生平文本，限 1000 字（官方一篇几百字，超了多半是误贴）。 */
			const bio = String(form.characterIntro || "").trim().slice(0, 1000);
			if (bio) payload.characterIntro = bio;

			/* 修改已有：带上「改的是哪个扩展的哪个武将」与读出来的原值，
			 * AI 据此算出用户动了哪些字段，只改那几处。 */
			if (form.editTarget && typeof form.editTarget === "object") {
				payload.editTarget = form.editTarget;
			}

			/* 上传过的扩展在工作区里的落点 —— AI 靠它追加/改写（不加就丢了） */
			if (form.uploadPath) payload.uploadPath = String(form.uploadPath);

			/* 标记这份提交「还没被处理」。
			 * 不搭队列（那太重），但至少让接手的人分得清：
			 * 两次连续提交会覆盖前一份（已知限制），而 processed=false 说明
			 * 「最新这份还没做」；AI 做完把它改成 true，下次就能看出是否已处理。 */
			payload.processed = false;
			payload.submittedAt = payload.submittedAt || new Date().toISOString();

			const outPath = join(TMP_DIR, "latest-request.json");
			await writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
			log("[handoff] 表单已落盘：", outPath, "（技能", payload.skills.length, "个）");

			res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ ok: true, path: outPath }));
		} catch (e) {
			res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	/* 其余按静态资源处理 */
	await serveStatic(res, path);
});

/* 依次试候选端口，撞上占用就换下一个 */
async function listenWithFallback() {
	for (const port of PORT_CANDIDATES) {
		try {
			await new Promise((resolve, reject) => {
				const onError = (err) => {
					server.removeListener("listening", onOk);
					reject(err);
				};
				const onOk = () => {
					server.removeListener("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onOk);
				server.listen(port, "127.0.0.1");
			});
			PORT = port;
			return true;
		} catch (err) {
			if (err.code !== "EADDRINUSE") {
				log(`  端口 ${port} 监听失败：${err.message}`);
				return false;
			}
			log(`  端口 ${port} 被占用，试下一个`);
		}
	}
	return false;
}

listenWithFallback().then((ok) => {
	if (!ok) {
		log("所有候选端口都被占用了。指定一个空闲端口再启动：");
		log(`  DIY_PORT=18999 node ${__dirname}/server.mjs`);
		process.exit(1);
	}
	log("═".repeat(58));
	log("无名杀 · DIY 工坊本地服务已启动");
	log(`  工坊页面  http://127.0.0.1:${PORT}/`);
	log(`  工作区    ${WORKSPACE}`);
	if (PORT !== PORT_CANDIDATES[0]) {
		log(`  注意：默认端口 ${PORT_CANDIDATES[0]} 被占用，已改用 ${PORT}`);
		log("        页面会自动找到这个端口，不用手动改");
	}
	log("═".repeat(58));
});

/* 收到信号就干净退出 */
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		log("收到", sig, "，正在退出…");
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 1500);
	});
}