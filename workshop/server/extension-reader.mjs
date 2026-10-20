/* ==========================================================================
 * 读取已有扩展里的武将数据
 *
 * 用途：网页工坊的「修改已有」模式 —— 选一个扩展、选一个武将，
 * 把他的信息（称号/势力/性别/体力/技能/立绘）填回表单。
 *
 * 难点：扩展里的 character.js 是 ES 模块，不能 JSON.parse。
 * 这里不执行它（执行会连带加载 noname.js），而是用与 check-extension.mjs
 * 同一套思路做**结构化文本解析**：括号配对 + 跳过字符串与注释。
 *
 * 局限（要诚实）：只认常规写法。动态生成的技能、变量拼接的字段读不到，
 * 那种情况直接报"读不出武将"，让用户手动填写，不要臆测。
 * ==========================================================================*/

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

/* ── 底层：提取 `name = { ... }` 的块内容 ───────────────────────────────── */

function extractBlock(src, name) {
	const re = new RegExp(
		`(^|\\n)[\\t ]*(?:export\\s+)?(?:const\\s+|let\\s+|var\\s+)?${name}\\s*[:=]\\s*\\{`,
		"m",
	);
	const m = re.exec(src);
	if (!m) return null;

	let i = src.indexOf("{", m.index + m[0].length - 1);
	if (i < 0) return null;

	let depth = 0;
	let inStr = null;
	let inLineComment = false;
	let inBlockComment = false;

	for (let j = i; j < src.length; j++) {
		const c = src[j];
		const next = src[j + 1];

		if (inLineComment) {
			if (c === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (c === "*" && next === "/") {
				inBlockComment = false;
				j++;
			}
			continue;
		}
		if (inStr) {
			if (c === "\\") {
				j++;
				continue;
			}
			if (c === inStr) inStr = null;
			continue;
		}

		if (c === "/" && next === "/") {
			inLineComment = true;
			j++;
			continue;
		}
		if (c === "/" && next === "*") {
			inBlockComment = true;
			j++;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inStr = c;
			continue;
		}

		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return src.slice(i + 1, j);
		}
	}
	return null;
}

/* 把块内容按顶层 `key: value` 切开，返回 [key, valueText][] */
function splitTopLevel(body) {
	const out = [];
	let depth = 0;
	let inStr = null;
	let inLineComment = false;
	let inBlockComment = false;
	let start = 0;
	let key = null;
	let colonAt = -1;

	const pushPending = (endIdx) => {
		if (key !== null) {
			out.push([key, body.slice(colonAt + 1, endIdx).trim()]);
			key = null;
			colonAt = -1;
		}
	};

	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		const next = body[i + 1];

		if (inLineComment) {
			if (c === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (c === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inStr) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === inStr) inStr = null;
			continue;
		}

		if (c === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (c === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inStr = c;
			continue;
		}

		if (c === "{" || c === "[" || c === "(") depth++;
		else if (c === "}" || c === "]" || c === ")") depth--;

		if (depth === 0) {
			if (c === ":" && key === null) {
				/* 只取最后一个换行之后的部分 —— 前面可能是注释或空行。
				 * 直接整段 trim 会把注释带进来，键名就认不出了。 */
				const rawKey = body
					.slice(start, i)
					.split("\n")
					.pop()
					.trim()
					.replace(/^["'`]|["'`]$/g, "");
				/* 键名里可以带 `#` 前缀与 `:` `/` `.` —— 台词键就长这样：
				 * `"#guanyu1:die"`、`"#ext:扩展名/audio/wusheng1"`（官方扩展
				 * 一律加引号写，取样见引擎源码 `character/bingshi/voices.js`）。 */
				if (/^#?[A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5\-:/.]*$/.test(rawKey)) {
					key = rawKey;
					colonAt = i;
				}
			} else if (c === "," && key !== null) {
				pushPending(i);
				start = i + 1;
			}
		}
	}
	pushPending(body.length);
	return out;
}

/* 字符串字面量取值 */
function literalString(text) {
	const m = /^\s*["'`]([\s\S]*?)["'`]\s*$/.exec(text);
	return m ? m[1] : null;
}

/* 数字字面量取值 */
function literalNumber(text) {
	const m = /^\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
	return m ? Number(m[1]) : null;
}

/* 体力字面量：`4`、`"4"`、`"4/6"`、`"4/6/2"`、`"∞"` 都认
 * （引擎写法见 references/无名杀武将指南.md 2.3）。
 * 读回来一律是字符串：`4` / `4/6` / `4/6/2` / `∞` —— 写回表单时再补成三段。
 * 必须原样带回 `"4/6"` 与 `"∞"`：只取第一个数会把体力上限静默吞掉，
 * ∞ 认不出则会被换成别的值，用户再提交就改了设定。 */
function literalHp(text) {
	const num = literalNumber(text);
	if (num !== null) return String(num);

	const s = literalString(text);
	if (s !== null) {
		const t = s.trim();
		if (t === "∞" || t === "Infinity") return t;
		if (/^\d+\s*\/\s*\d+(?:\s*\/\s*\d+)?$/.test(t)) return t.replace(/\s+/g, "");
		return null;
	}

	/* 不带引号的 Infinity 也是合法写法 */
	const bare = String(text == null ? "" : text).trim();
	if (bare === "∞" || bare === "Infinity") return bare;
	return null;
}

/* 数组里所有字符串字面量 */
function literalStringArray(text) {
	const out = [];
	const re = /["'`]([^"'`]*)["'`]/g;
	let m;
	while ((m = re.exec(text))) out.push(m[1]);
	return out;
}

/* 扁平对象 -> { key: "值" }（用于 translate / title 这种 key: "文本" 的表） */
function flatMap(body) {
	const out = {};
	if (!body) return out;
	for (const [k, v] of splitTopLevel(body)) {
		const s = literalString(v);
		if (s !== null) out[k] = s;
	}
	return out;
}

/* 提取从某个 `{` 开始的配对块内容 */
function extractBlockAt(src, openIdx) {
	let depth = 0;
	let inStr = null;
	let inLineComment = false;
	let inBlockComment = false;

	for (let j = openIdx; j < src.length; j++) {
		const c = src[j];
		const next = src[j + 1];

		if (inLineComment) { if (c === "\n") inLineComment = false; continue; }
		if (inBlockComment) { if (c === "*" && next === "/") { inBlockComment = false; j++; } continue; }
		if (inStr) { if (c === "\\") { j++; continue; } if (c === inStr) inStr = null; continue; }

		if (c === "/" && next === "/") { inLineComment = true; j++; continue; }
		if (c === "/" && next === "*") { inBlockComment = true; j++; continue; }
		if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }

		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return src.slice(openIdx + 1, j);
		}
	}
	return null;
}

/*
 * 同名块可能有**多段** —— 扩展常把 translate 分几处写
 * （例如入口附近一段、角色定义旁边一段）。
 * 只取第一段会漏掉中文名，导致界面上显示英文 id。
 */
function flatMapAll(src, name) {
	const out = {};
	const re = new RegExp(
		`(^|\\n)[\\t ]*(?:export\\s+)?(?:const\\s+|let\\s+|var\\s+)?${name}\\s*[:=]\\s*\\{`,
		"gm",
	);
	let m;
	while ((m = re.exec(src))) {
		const openAt = src.indexOf("{", m.index + m[0].length - 1);
		if (openAt < 0) continue;
		const body = extractBlockAt(src, openAt);
		if (body) Object.assign(out, flatMap(body));
	}
	return out;
}

/* ── 台词：从翻译表里取回 ────────────────────────────────────────────────
 * 引擎把每句台词存成 `lib.translate["#<音频地址>N"]`（技能）或
 * `"#<音频地址>N:die"`（阵亡），N 从 1 开始（规格见 `docs/audio-guide.md` 与规范 8.1；
 * 音频地址是**剥掉默认路径**后的样子 ——
 * `skill/` 与 `die/` 都不出现，所以技能直接按
 * 技能 id 找、阵亡直接按角色 id 找。
 *
 * 两种写法都认：带序号的 `#<地址>1`，以及不带序号的 `#<地址>`（`audio: true`）。
 * 序号要求**连续**，断了就停 —— 否则会把别的技能 `#xx10` 误当成本技能第 10 句。
 * 局限：键没加引号、又带 `:` 的写法（`#guanyu1:die: "..."`）读不出来；
 * 官方与社区一律加引号写，此处不臆测。 */
function collectLines(map, base, suffix) {
	const numbered = [];
	for (let i = 1; i <= 20; i++) {
		const v = map[`#${base}${i}${suffix}`];
		if (v == null || v === "") break;
		numbered.push(v);
	}
	if (numbered.length) return numbered;

	const direct = map[`#${base}${suffix}`];
	return direct == null || direct === "" ? [] : [direct];
}

/* ── 对外：找扩展、读武将 ───────────────────────────────────────────────── */

/* 扫描两个位置：工作区的「扩展源码」与游戏包内的 extension/ */
export async function listExtensions(workspace) {
	const out = [];
	const seen = new Set();

	async function scan(base, origin) {
		const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			if (!e.isDirectory() || seen.has(e.name)) continue;
			const dir = join(base, e.name);
			if (!existsSync(join(dir, "extension.js"))) continue;
			seen.add(e.name);
			out.push({ name: e.name, origin, path: dir });
		}
	}

	await scan(join(workspace, "扩展源码"), "工作区");

	const tops = await readdir(workspace, { withFileTypes: true }).catch(() => []);
	for (const top of tops) {
		if (!top.isDirectory() || top.name.startsWith(".")) continue;
		const pkgRoot = join(workspace, top.name);
		const inners = await readdir(pkgRoot, { withFileTypes: true }).catch(() => []);
		for (const inner of inners) {
			if (!inner.isDirectory()) continue;
			await scan(join(pkgRoot, inner.name, "resources", "app", "extension"), "游戏包");
		}
	}

	return out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/* 与 server.mjs 里那套一致：先看工作区，再看游戏包 */
async function findDir(workspace, name) {
	const direct = join(workspace, "扩展源码", name);
	if (existsSync(join(direct, "extension.js"))) return direct;

	const tops = await readdir(workspace, { withFileTypes: true }).catch(() => []);
	for (const top of tops) {
		if (!top.isDirectory() || top.name.startsWith(".")) continue;
		const pkgRoot = join(workspace, top.name);
		const inners = await readdir(pkgRoot, { withFileTypes: true }).catch(() => []);
		for (const inner of inners) {
			if (!inner.isDirectory()) continue;
			const guess = join(pkgRoot, inner.name, "resources", "app", "extension", name);
			if (existsSync(join(guess, "extension.js"))) return guess;
		}
	}
	return null;
}

/*
 * 读一个扩展里的武将。
 * 返回 { name, path, characters: [...] }；读不出武将时 characters 为空数组。
 */
/* 给定扩展目录直接解析（上传解压后用这条） */
export async function readExtensionCharactersAt(dir) {
	return parseExtensionDir(dir);
}

export async function readExtensionCharacters(workspace, name) {
	const dir = await findDir(workspace, name);
	if (!dir) return null;
	return parseExtensionDir(dir);
}

/* 把一组文件读成文本（不存在或读不了的都跳过） */
async function readSources(paths) {
	const out = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			out.push(await readFile(p, "utf8"));
		} catch {
			/* 读不了就跳过 */
		}
	}
	return out;
}

/* 读包级介绍：扩展写在 info.json 的 `intro` 里；官方包没有 info.json，返回空串。
 * 坏掉或缺失都不致命 —— 引擎自己有兜底值，这边就当没写。 */
async function readInfoIntro(dir) {
	try {
		const infoPath = join(dir, "info.json");
		if (!existsSync(infoPath)) return "";
		const info = JSON.parse(await readFile(infoPath, "utf8"));
		return typeof info.intro === "string" ? info.intro : "";
	} catch {
		return "";
	}
}

/* 扩展包的入口（相对包根）：角色与翻译可能分散在多个文件里 */
const EXTENSION_ENTRY_FILES = ["character/character.js", "character.js", "extension.js"];

async function parseExtensionDir(dir) {
	return parseSources({
		paths: EXTENSION_ENTRY_FILES.map((rel) => join(dir, rel)),
		name: basename(dir),
		path: dir,
		/* 立绘在包内找 */
		avatarDirs: [dir],
		intro: await readInfoIntro(dir),
	});
}

/*
 * 从若干源码文本里解析出武将。扩展包与官方包共用这一段 ——
 * 两者的顶层写法一样（`const characters` / `translates` / `characterTitles`），
 * 不同的只有三处：读哪些文件、立绘去哪找、包级介绍从哪来。所以那三样走参数。
 */
async function parseSources({ paths, name, path, avatarDirs, intro = "", cleanInterpolation = false }) {
	const sources = await readSources(paths);

	/* 先把所有文件的翻译表汇总：技能名 / <id>_info / <id>_bg 都在这里 */
	const translates = {};
	const titles = {};
	for (const src of sources) {
		/* 用 flatMapAll：同一张表可能分几段写，只读第一段会漏掉中文名 */
		Object.assign(translates, flatMapAll(src, "translate"));
		Object.assign(translates, flatMapAll(src, "translates"));
		Object.assign(titles, flatMapAll(src, "characterTitle"));
		Object.assign(titles, flatMapAll(src, "characterTitles"));
	}

	/* 官方包描述里的术语表：一次扫好 —— 别在每个技能上重扫一遍整个包（可能几百 KB） */
	const poptipNames = cleanInterpolation ? collectPoptipNames(sources) : {};

	const characters = [];
	const seenIds = new Set();
	let sawBlock = false;      /* 找到过角色表 */
	let skippedAsField = 0;    /* 被当成 packs 字段跳过的条目数 */
	let sawEntry = false;      /* 见过形状像角色条目的内容 */

	for (const src of sources) {
		const charBody = extractBlock(src, "characters") || extractBlock(src, "character");
		if (!charBody) continue;
		sawBlock = true;

		for (const [id, rawBody] of splitTopLevel(charBody)) {
			if (seenIds.has(id)) continue;
			/* 跳过 packs 的字段名 —— 它们不是武将 */
			if (PACK_FIELD_NAMES.has(id)) {
				skippedAsField++;
				continue;
			}

			const body = rawBody.trim();
			if (body.startsWith("{") || body.startsWith("[")) sawEntry = true;
			let info = null;

			if (body.startsWith("{")) {
				/* 对象式：{ sex, group, hp, skills, img } */
				const inner = body.slice(1, body.lastIndexOf("}"));
				const fields = splitTopLevel(inner);
				const get = (key) => {
					const hit = fields.find(([k]) => k === key);
					return hit ? hit[1] : null;
				};
				info = {
					sex: literalString(get("sex")) || "male",
					group: literalString(get("group")) || "qun",
					hp: literalHp(get("hp")) ?? "4",
					skills: literalStringArray(get("skills") || ""),
					img: literalString(get("img")),
				};
			} else if (body.startsWith("[")) {
				/* 数组式：[性别, 势力, 体力, 技能数组, 附加项] */
				const parts = splitArrayParts(body);
				info = {
					sex: literalString(parts[0]) || "male",
					group: literalString(parts[1]) || "qun",
					hp: literalHp(parts[2]) ?? "4",
					skills: literalStringArray(parts[3] || ""),
					img: null,
				};
			}

			/* 认不出的写法跳过，不臆测 */
			if (!info) continue;

			characters.push({
				id,
				name: translates[id] || id,
				title: titles[id] || translates[`${id}_prefix`] || "",
				sex: info.sex,
				group: info.group,
				hp: info.hp,
				avatar: findAvatarIn(avatarDirs, id, info.img),
				skills: info.skills.map((sid) => {
					const rawDesc = translates[`${sid}_info`] || "";
					const skill = {
						id: sid,
						name: translates[sid] || sid,
						/* 官方包的描述常带运行时插值，文本解析拿不到求值结果 ——
						 * 那种只在「官方包当模板」时清理（见 cleanDesc）。
						 * 扩展包一律原样带回：回填后要写回去，动一个字就是改用户的描述。 */
						desc: cleanInterpolation ? cleanDesc(rawDesc, translates, poptipNames) : rawDesc,
					};
					const lines = collectLines(translates, sid, "");
					if (lines.length) skill.lines = lines;
					return skill;
				}),
				/* 阵亡台词**不读**：工坊暂时不收它，
				 * 读了也没地方回填。技能台词照旧。 */
			});
			seenIds.add(id);
		}
	}

	return {
		name,
		path,
		characters,
		/* 扩展包介绍：**整包**级字段，在 info.json 里（引擎读它见 `init/import.js`）。
		 * 它不属于任何一个武将，单独带出来给「修改已有」填回表单。
		 * info.json 缺失或坏了都不致命 —— 引擎自己有兜底值，这边就当没写。 */
		intro,
		/* 读不出时给出原因，前端据此提示用户手填 */
		unreadable:
			characters.length > 0
				? null
				: !sawBlock
					? "没找到角色定义（可能是 game.import 独立注册的包）"
					: skippedAsField > 0 && !sawEntry
						? "找到的是 packs 字段而不是武将（这个扩展可能没有武将，或武将写在别处）"
						: "解析不出武将条目（可能是动态生成或写法特殊）",
	};
}

/*
 * 清理描述里的运行时插值。
 *
 * 官方包的描述大量用 `${get.poptip({...})}` 做悬浮提示，那是**运行时**求值的，
 * 文本解析只能原样读到源码 —— 直接给用户看就是一坨 `get.poptip({id:"..."})`。
 * 所以把能认出来的插值换成它的可读内容：
 *   `${get.poptip({id, name: "应机牌", info: "..."})}` → `应机牌`
 *   `${get.poptip("potshanxi_yingji")}`              → 该键的翻译值（取不到就抹掉）
 *   其余 `${...}`                                     → 抹掉
 * **只动插值本身，描述正文一个字不改**；而且只在官方包（只读、当模板）上用 ——
 * 扩展包的描述要回写，任何"顺手清理"都等于改用户的作品。
 */
function cleanDesc(text, translates, poptipNames = {}) {
	return String(text)
		.replace(/\$\{get\.poptip\(\s*\{[^{}]*?name:\s*["'`]([^"'`]+)["'`][^{}]*\}\s*\)\}/g, "$1")
		/* 只写 id 的那种：先查术语表（同文件里带名字的插值给的），再查翻译表；
		 * 都没有就**保留原 id** —— 抹成空会让句子断掉（"标记为，若此牌…"），
		 * 留着 id 至少还能回引擎源码里查它是什么。 */
		.replace(
			/\$\{get\.poptip\(\s*["'`]([^"'`]+)["'`]\s*\)\}/g,
			(_m, key) => poptipNames[key] || translates[key] || key,
		)
		.replace(/\$\{[^{}]*\}/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/* 收集 `${get.poptip({id, name})}` 里给出的 显示名：id → 名字。
 * 同一个包里的插值常一半带名字、一半只写 id，靠这张表把后者补全。 */
function collectPoptipNames(sources) {
	const map = {};
	const re =
		/\$\{get\.poptip\(\s*\{[^{}]*?id:\s*["'`]([^"'`]+)["'`][^{}]*?name:\s*["'`]([^"'`]+)["'`]/g;
	for (const src of sources) {
		let m;
		while ((m = re.exec(src))) map[m[1]] = m[2];
	}
	return map;
}

/* 按顶层逗号切开数组字面量（剥掉首尾方括号） */
function splitArrayParts(text) {
	const inner = text.trim().replace(/^\[/, "").replace(/\]$/, "");
	const out = [];
	let depth = 0;
	let inStr = null;
	let start = 0;

	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (inStr) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === inStr) inStr = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inStr = c;
			continue;
		}
		if (c === "[" || c === "{" || c === "(") depth++;
		else if (c === "]" || c === "}" || c === ")") depth--;
		else if (c === "," && depth === 0) {
			out.push(inner.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(inner.slice(start).trim());
	return out;
}

/*
 * 找头像。优先级：显式 img 字段 -> 引擎默认（扩展根目录）-> 社区常见的几个子目录。
 * 引擎本身只在根目录找，但社区扩展常把图放 character/ 或 image/ 下，
 * 多探几处能省掉用户手填立绘的麻烦。
 */
/*
 * packs 的字段名 —— 它们长得像角色条目（值是对象），但不是武将。
 * 扩展里 `character: { character: characters, translate: {...} }` 这种写法
 * 会让"找角色表"误命中外层，把 translate 当成一个武将。
 */
const PACK_FIELD_NAMES = new Set([
	"character", "characters", "characterSort", "characterSortTranslate",
	"characterTitle", "characterTitles", "characterIntro", "characterFilter",
	"dynamicTranslate", "perfectPair", "perfectPairs", "pinyin", "pinyins",
	"translate", "translates", "skill", "skills", "card", "cards",
	"connect", "editable", "config", "help", "package", "files",
	"intro", "author", "version", "diskURL", "forumURL",
]);

const AVATAR_SUBDIRS = ["", "character/", "character/characters/", "image/", "image/character/"];

function findAvatarIn(dirs, id, imgField) {
	const candidates = [];
	if (imgField) {
		const bare = imgField
			.replace(/^(?:ext|db:extension-[^:]*|die):/, "")
			.replace(/^[^/]*\//, "");
		candidates.push(imgField, bare);
	}
	candidates.push(`${id}.jpg`, `${id}.png`, `${id}.webp`);

	for (const name of candidates) {
		if (!name) continue;
		/* 带斜杠的按原样试；光文件名的拼上各常见子目录 */
		const rels = name.includes("/") ? [name] : AVATAR_SUBDIRS.map((d) => d + name);
		for (const dir of dirs) {
			for (const rel of rels) {
				const p = join(dir, rel);
				if (existsSync(p)) return p;
			}
		}
	}
	return null;
}

/* ── 官方包（游戏自带的武将包）───────────────────────────────────────────
 * 「官方包」是拿来当**模板**的：读它的武将信息填进表单，用户改完落成自己的扩展。
 * 官方武将**不能改**（红线：绝不动游戏本体），所以这里只读、不写。
 *
 * 与扩展包的三处不同：
 *   ① 入口不是 extension.js —— 可能是扁平的 character/<包名>.js，
 *      也可能是一包一目录的 character/<包名>/character.js；
 *   ② 立绘不在包里，全在 <游戏根>/image/character/<角色id>.jpg；
 *   ③ 没有 info.json（包级介绍为空）。
 * 顶层写法（const characters / translates / characterTitles）与扩展一致，
 * 解析主体因此复用 parseSources。
 *
 * 边界（写死，不要放宽）：**只扫 <游戏根>/character/ 这一层**。
 * 绝不扫 extension/（那里是 UI 美化、特效美化这类第三方扩展），
 * 也不扫 image/ 以外的素材与玩法目录。契约测试里有对应断言。
 */

/* 游戏根 = <工作区>/<整合包>/<平台目录>/resources/app（下扫两层，与 findDir 同规矩） */
async function findGameRoots(workspace) {
	const out = [];
	const tops = await readdir(workspace, { withFileTypes: true }).catch(() => []);
	for (const top of tops) {
		if (!top.isDirectory() || top.name.startsWith(".")) continue;
		const pkgRoot = join(workspace, top.name);
		const inners = await readdir(pkgRoot, { withFileTypes: true }).catch(() => []);
		for (const inner of inners) {
			if (!inner.isDirectory()) continue;
			const app = join(pkgRoot, inner.name, "resources", "app");
			if (existsSync(join(app, "character"))) out.push(app);
		}
	}
	return out;
}

/* 一个官方包要读哪些文件（扁平单文件 / 一包一目录两种形态） */
function officialPackFiles(charDir, pack) {
	const flat = join(charDir, `${pack}.js`);
	if (existsSync(flat)) return [flat];
	const dir = join(charDir, pack);
	if (!existsSync(dir)) return [];
	const out = [];
	for (const rel of ["character.js", "index.js", "characterTitle.js", "translate.js", "dynamicTranslate.js"]) {
		const p = join(dir, rel);
		if (existsSync(p)) out.push(p);
	}
	return out;
}

/* 只数武将个数 —— 列包时不值得做完整解析（单包几百 KB），数一下够用 */
async function countOfficialCharacters(files) {
	let n = 0;
	for (const src of await readSources(files)) {
		const body = extractBlock(src, "characters") || extractBlock(src, "character");
		if (!body) continue;
		for (const [id] of splitTopLevel(body)) {
			if (!PACK_FIELD_NAMES.has(id)) n++;
		}
	}
	return n;
}

/* 包的显示名：中文篇名在 `characterSortTranslate` 的值里（键是 bingshi_qi 这类 id，
 * 给人看的是值）；取不到再退回 `characterSort` 的键，最后才用包名。 */
async function officialPackLabel(files) {
	for (const src of await readSources(files.slice(0, 2))) {
		const trans = extractBlock(src, "characterSortTranslate");
		if (trans) {
			const vals = splitTopLevel(trans)
				.map(([, v]) => String(v).replace(/^["'`]|["'`]$/g, "").trim())
				.filter(Boolean);
			if (vals.length) return vals.slice(0, 2).join(" / ");
		}
		const sort = extractBlock(src, "characterSort");
		if (sort) {
			const keys = splitTopLevel(sort)
				.map(([k]) => String(k).replace(/^["'`]|["'`]$/g, "").trim())
				.filter(Boolean);
			if (keys.length && /[\u4e00-\u9fff]/.test(keys[0])) return keys.slice(0, 2).join(" / ");
		}
	}
	return "";
}

/*
 * 列出可用的官方包。**读不出武将的条目不列**（如 perfectPairs.js、rank.js
 * 这类辅助数据）—— "这是不是一个武将包"用数据说话，不靠文件名猜。
 */
export async function listOfficialPacks(workspace) {
	const out = [];
	const seen = new Set();
	for (const app of await findGameRoots(workspace)) {
		const charDir = join(app, "character");
		const entries = await readdir(charDir, { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			const pack = e.isDirectory() ? e.name : e.name.endsWith(".js") ? e.name.slice(0, -3) : null;
			if (!pack || pack.startsWith(".") || seen.has(pack)) continue;
			const files = officialPackFiles(charDir, pack);
			if (!files.length) continue;
			const count = await countOfficialCharacters(files);
			if (count <= 0) continue;
			seen.add(pack);
			out.push({ name: pack, label: (await officialPackLabel(files)) || pack, count });
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/*
 * 读一个官方包的武将。
 * 立绘在游戏目录里，而前端读图只能读工作区 —— 所以把用到的图**复制进工作区**
 * （`.diy-workshop/official-art/`）再把路径交出去。那是参考图：用户裁了才进产物。
 */
export async function readOfficialPack(workspace, pack) {
	for (const app of await findGameRoots(workspace)) {
		const charDir = join(app, "character");
		const files = officialPackFiles(charDir, pack);
		if (!files.length) continue;
		const parsed = await parseSources({
			paths: files,
			name: pack,
			path: join(charDir, pack),
			/* 立绘：先看包里（少数包自带），再去 image/character/ */
			avatarDirs: [join(app, "image", "character"), charDir, join(charDir, pack), app],
			intro: "",
			/* 官方包只读、当模板，描述里的运行时插值可以清理干净给人看 */
			cleanInterpolation: true,
		});
		parsed.label = (await officialPackLabel(files)) || pack;
		parsed.source = "official";
		/* 官方武将不能改 —— 前端与规范都靠这个标记决定"只能另建扩展" */
		parsed.readonly = true;
		await stashOfficialAvatars(workspace, parsed.characters, pack);
		return parsed;
	}
	return null;
}

async function stashOfficialAvatars(workspace, characters, pack) {
	const dir = join(workspace, ".diy-workshop", "official-art");
	await rm(dir, { recursive: true, force: true }).catch(() => {});
	await mkdir(dir, { recursive: true }).catch(() => {});
	for (const c of characters) {
		if (!c.avatar || !existsSync(c.avatar)) {
			c.avatar = null;
			continue;
		}
		const ext = (String(c.avatar).match(/\.(jpe?g|png|webp)$/i) || [".jpg"])[0];
		const dst = join(dir, `${pack}_${c.id}${ext}`.replace(/[^\w.\-]/g, "_"));
		try {
			await copyFile(c.avatar, dst);
			c.avatar = dst;
		} catch {
			/* 复制不了就当没有立绘，不影响其它字段 */
			c.avatar = null;
		}
	}
}

/* 便于单测的内部函数导出（不影响运行） */
export const __testExports = { extractBlock, splitTopLevel, flatMap, literalString };
