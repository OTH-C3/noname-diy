#!/usr/bin/env node
/**
 * 无名杀扩展 · 静态检查
 * ============================================================================
 * 用法：
 *   node check-extension.mjs <扩展目录> [引擎源码根]
 *
 * 定位：这是给「AI 生成完的扩展」和「手写的扩展」共用的一道闸门。
 * 它不执行扩展代码（那需要 noname 运行时），而是用文本分析 + 对照引擎源码，
 * 把《无名杀避坑清单》里能自动化的部分挑出来。
 *
 * 检查项（15 类，按输出顺序；不带引擎源码根时第 10 / 13 / 15 类自动跳过）：
 *   1. 必备文件：extension.js / character/character.js / info.json
 *   2. 语法：按 ESM 解析（把内容喂给 `node --input-type=module --check`；
 *      直接 `node --check 文件` 对含 import/export 的文件永远返回 0，等于没查）
 *   3. 跨表一致性：characters ↔ skills ↔ translates ↔ characterSort ↔ 头像
 *   4. packs 结构：两层分组（character / skill）、connect、characterSort 第一层 key
 *   5. 扩展名四处一致：目录名 / extension.js / info.json / characterSort
 *   6. 技能类型字段：locked 必须配 forced（这是真实发生过的问题）
 *   7. 视为技的 AI 响应标记：viewAs 当【闪】/【桃】/【杀】用却没写 respondShan 等
 *   8. ai 字段缺失：有 enable / trigger 却没有 ai（forced 的排除）
 *   9. gaintag 的 eternal_ 前缀：不写前缀，牌一移动标记就被清
 *  10. 时机名核实：对照引擎源码
 *  11. 描述与实现一致性：描述里的「可 / 须」与 forced 是否矛盾
 *  12. 台词键：不带文件后缀、序号连续
 *  13. id 撞名：对照引擎源码，撞名会被静默丢弃
 *  14. storage 生命周期：写入 storage 的技能是否有 init / onremove
 *  15. 引擎 API 存在性：引用的 game./player./lib./get./ui. 方法是否真实存在
 *
 * 注意：输出的每一项「[通过]」都是**结论**，不是「已执行」——
 * 只在确实没查出问题时才打印（曾有三处无条件 ok()，坏样本里会出现
 * 「刚报错、紧跟着又说通过」的自相矛盾）。
 * ==========================================================================*/

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── 输出 ──────────────────────────────────────────────────────────────── */
const problems = [];
const passes = [];
let currentSection = "";

function section(title) {
	currentSection = title;
	console.log(`\n── ${title} ${"─".repeat(Math.max(0, 56 - title.length * 2))}`);
}

function ok(msg) {
	passes.push(`[${currentSection}] ${msg}`);
	console.log(`  [通过] ${msg}`);
}

function bad(msg, level = "错误") {
	problems.push({ section: currentSection, level, msg });
	console.log(`  ${level === "错误" ? "[错误]" : "[警告] "} ${msg}`);
}

/* ── 文本分析工具 ──────────────────────────────────────────────────────── */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ── 语法检查（必须显式按 ESM 解析）────────────────────────────────────
 * 坑：直接 `node --check 文件名` 对含 import/export 的文件**永远返回 0** ——
 * Node 的模块类型探测在 --check 这条路上不报错，于是这一项对扩展形同虚设：
 * 语法写坏了照样打「语法通过」，要等运行到那一行才炸。2026-10-14 实测确认
 * （`export const a=1; const b = ;` → node --check 退出码 0，但真的执行就 SyntaxError）。
 * 修法：把文件内容从 stdin 喂进去，并显式声明 --input-type=module。 */
async function checkEsmSyntax(file) {
	let text;
	try {
		text = await readFile(file, "utf-8");
	} catch (e) {
		return { err: e };
	}
	return new Promise((done) => {
		let child;
		try {
			child = spawn(process.execPath, ["--input-type=module", "--check"], {
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (e) {
			done({ err: e });
			return;
		}
		let errText = "";
		child.stdout.on("data", () => {});
		child.stderr.on("data", (d) => {
			errText += d;
		});
		child.on("error", (e) => done({ err: e }));
		child.on("close", (code) => {
			if (code === 0) {
				done({ err: null });
				return;
			}
			/* node 的报错第一行是 `[stdin]:2`、第二行是源码 —— 取真正的 Error 那行 */
			const line =
				errText.split("\n").find((l) => /Error/.test(l)) || errText.trim().split("\n")[0] || `退出码 ${code}`;
			done({ err: Object.assign(new Error(line.trim()), { code }) });
		});
		child.stdin.on("error", () => {}); /* 提前退出时忽略 EPIPE */
		child.stdin.end(text);
	});
}

/* ── 引擎源码检索（纯 Node，不依赖系统 grep）─────────────────────────────
 * 这三处原先用 execFile("grep")，在 Windows 上等于**反着报**：
 * 系统没有 grep（PowerShell 的 grep 只是别名，execFile 调不动），stdout 为空 →
 * 「时机名一个都找不到」「68 个常用 API 全部不存在」，使用者照着报告去改
 * 本来正确的代码。2026-10-12 反馈里危害最大的一条。
 * 现在自己遍历目录读 .js；一次检查里会检索好几轮，所以按目录缓存文件正文。 */
const _engineCache = new Map();

async function engineFiles(root) {
	const key = resolve(root);
	if (_engineCache.has(key)) return _engineCache.get(key);
	const out = [];
	const walk = async (dir, depth) => {
		if (depth > 12) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; /* 目录不存在或没权限：留空给调用方，由它给提示 */
		}
		for (const e of entries) {
			if (e.name === "node_modules" || e.name.startsWith(".")) continue;
			const p = join(dir, e.name);
			if (e.isDirectory()) await walk(p, depth + 1);
			else if (e.name.endsWith(".js")) {
				try {
					out.push({ path: p, text: await readFile(p, "utf-8") });
				} catch {
					/* 单个文件读不了就跳过 */
				}
			}
		}
	};
	await walk(key, 0);
	_engineCache.set(key, out);
	return out;
}

/* 哪些词在源码里出现过（等价 grep -rhoE） */
async function engineHasWord(root, words) {
	const files = await engineFiles(root);
	const pending = new Set(words);
	const found = new Set();
	for (const f of files) {
		for (const w of [...pending]) {
			if (f.text.includes(w)) {
				found.add(w);
				pending.delete(w);
			}
		}
		if (!pending.size) break;
	}
	return found;
}

/* 哪些文件命中这些词（等价 grep -rlnE）；字符串按子串、也可直接给正则 */
async function engineFilesWith(root, patterns) {
	const files = await engineFiles(root);
	const res = patterns.map((p) => (p instanceof RegExp ? p : new RegExp(escapeRegExp(p))));
	const hits = [];
	for (const f of files) {
		if (res.some((re) => re.test(f.text))) hits.push(f.path);
	}
	return hits;
}

/**
 * 从源码里抠出 `名称: { ... }` 这个块的正文，靠括号配对而不是正则贪婪匹配。
 * 找不到返回 null。
 */
function extractBlock(src, name) {
	/* 三种定义形态都要认：
	 *   `export const name = {` / `const name = {` / `name: {`（对象字面量里的键）
	 * 漏掉 `export` 会解析不出 packs —— 而 packs 恰恰是最需要检查的那个。 */
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

/** 抠出某个顶层对象里所有的直接子键名（只认第一层缩进的 key:） */
function topLevelKeys(body) {
	if (!body) return [];
	const keys = [];
	let depth = 0;
	let inStr = null;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		const next = body[i + 1];

		/* 注释必须先跳过：源码注释里常写 `content.js:10095`、`gameEvent.ts:262`
		 * 这类路径，不处理就会把 `js`、`ts` 当成技能键，凭空多出几个"技能"。 */
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
			if (c === "\\") i++;
			else if (c === inStr) inStr = null;
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
			/* 引号后紧跟冒号 = 带引号的键名（`"技能_info": "..."`），
			 * 不能当成字符串起始，否则这个键会被整段跳过。
			 * 社区扩展常这么写，漏了就会误报「缺少描述」。 */
			if (depth === 0) {
				const km = /^(["'`])([^"'`]+)\1\s*:/.exec(body.slice(i));
				if (km) {
					keys.push(km[2]);
					i += km[0].length - 1;
					continue;
				}
			}
			inStr = c;
			continue;
		}
		if (c === "{" || c === "(" || c === "[") depth++;
		else if (c === "}" || c === ")" || c === "]") depth--;
		else if (depth === 0) {
			/* 只在最外层找 `key:`。
			 * 标识符要同时支持 ASCII 与中文 —— 引擎里 characterSort 的第一层 key
			 * 就是扩展名（中文），只认 [A-Za-z_$] 会把它们全漏掉。 */
			const rest = body.slice(i);
			/* 键名可能带引号（`"技能_info": "..."`）—— 社区扩展常这么写。
			 * 不带引号时只认标识符，且支持中文（characterSort 第一层 key 是扩展名）。 */
			const m = /^(?:["'`]([^"'`]+)["'`]|([A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5]*))\s*:/.exec(rest);
			if (m) {
				keys.push(m[1] || m[2]);
				i += m[0].length - 1;
			}
		}
	}
	return [...new Set(keys)];
}

/** 去掉 subSkill 段。
 * 子技能有自己的 locked / forced / silent，扫父技能时把它们算进来会误判 ——
 * 「父技能描述说可选，却因为子技能带 forced 而报矛盾」就是这么来的。 */
function stripSubSkills(body) {
	const i = body.indexOf("subSkill");
	return i >= 0 ? body.slice(0, i) : body;
}

/** 取出 translates 里某个键的字符串值（支持单双引号与模板串） */
function extractTranslateValue(translatesBody, key) {
	if (!translatesBody) return null;
	const re = new RegExp(`(^|\\n)[\\t ]*["'\`]?${key}["'\`]?\\s*:\\s*(["'\`])([\\s\\S]*?)\\2`, "m");
	const m = re.exec(translatesBody);
	return m ? m[3] : null;
}

/* 找引擎源码根：显式参数 > 逐级向上找 > 找不到就交白卷（相关检查自动跳过）。
 * 为什么逐级找而不是写死相对层数：skill 装在 <X>/skills/<名>/ 还是
 * <X>/.dsh/skills/<名>/ 决定了几级能到 <X> —— 写死一定会错
 * （本机就错过一次：写 3 级落在 .dsh/引擎源码，实际在 <X>/引擎源码）。
 * 用户自己的无名杀通常不在这个树里（比如 D:\无名杀），那是 agent 找出来后
 * 当第二个参数传进来，见 references/无名杀接手流程.md「阶段 0 · 找无名杀」。 */
function findEngineRoot() {
	if (process.argv[3]) return resolve(process.argv[3]);
	let dir = resolve(__dirname, "..");
	for (let i = 0; i < 8; i++) {
		const named = join(dir, "引擎源码");
		if (existsSync(join(named, "character"))) return named;
		// 也认「本身就是引擎根」的目录：内核（noname/ + character/ + game/ + noname.js）
		if (["character", "game", "noname"].every((m) => existsSync(join(dir, m))) &&
			existsSync(join(dir, "noname.js"))) {
			return dir;
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return "";
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */
async function main() {
	/* 没有 --help 的话，`--help` 会被当成扩展目录名，报"扩展目录不存在" ——
	 * 那对第一次用的人很迷惑（2026-10-17 实测踩到）。 */
	if (process.argv.includes("-h") || process.argv.includes("--help")) {
		console.log(
			[
				"用法：",
				"  node scripts/check-extension.mjs <扩展目录> [引擎源码根]",
				"",
				"  <扩展目录>    要检查的扩展目录（含 extension.js）",
				"  [引擎源码根]  无名杀的 resources/app/src，或引擎源码仓库的 src/ 目录。",
				"                给了它才会做「时机名 / id 撞名 / API 存在性」这三项要读源码的检查；",
				"                不给就跳过，不会误报。",
				"",
				"示例：",
				"  node scripts/check-extension.mjs 扩展源码/我的包",
				'  node scripts/check-extension.mjs 扩展源码/我的包 "<游戏目录>/resources/app/src"',
			].join("\n"),
		);
		return;
	}
	const extDir = resolve(process.argv[2] || ".");
	const engineRoot = findEngineRoot();

	console.log("═".repeat(60));
	console.log("无名杀扩展 · 静态检查");
	console.log("  扩展目录：", extDir);
	console.log("  引擎源码：", engineRoot || "（没找到）",
		engineRoot ? "" : "→ 跳过依赖它的三项检查：时机名 / id 撞名 / API 存在性");
	console.log("═".repeat(60));

	if (!existsSync(extDir)) {
		console.log("[错误] 扩展目录不存在");
		process.exit(2);
	}

	const extName = basename(extDir);
	const charFile = join(extDir, "character", "character.js");
	const extFile = join(extDir, "extension.js");
	const infoFile = join(extDir, "info.json");

	/* ── 0. 必备文件 ─────────────────────────────────────────────────── */
	section("必备文件");
	for (const [label, p] of [
		["extension.js", extFile],
		["character/character.js", charFile],
		["info.json", infoFile],
	]) {
		if (existsSync(p)) ok(label);
		else bad(`缺少 ${label}`);
	}

	let src = "";
	if (existsSync(charFile)) src = await readFile(charFile, "utf8");

	/* ── 1. 语法 ─────────────────────────────────────────────────────── */
	section("语法");
	for (const p of [extFile, charFile].filter(existsSync)) {
		/* 扩展是 ESM 且 import 了 noname.js，用 --input-type=module 只查语法 */
		const { err } = await checkEsmSyntax(p);
		if (!err) {
			ok(`${basename(p)} 语法通过`);
		} else if (/EPERM|EACCES/.test(String(err.code || err.message))) {
			/* 沙箱不许起子进程（spawn EPERM）—— 这是环境限制，不是扩展写错了。
			 * 报成「语法错误」会让人白改一遍，所以标成跳过并继续跑后面的检查。 */
			bad(`${basename(p)} 语法检查跳过：当前环境不允许起子进程（${err.code || "?"}）`, "警告");
		} else {
			bad(`${basename(p)} 语法错误：${err.message}`);
		}
	}

	/* ── 2. 跨表一致性 ───────────────────────────────────────────────── */
	section("跨表一致性");

	const charactersBody = extractBlock(src, "characters");
	const skillsBody = extractBlock(src, "skills");
	const translatesBody = extractBlock(src, "translates");
	const sortBody = extractBlock(src, "characterSort");

	const characterIds = topLevelKeys(charactersBody);
	const skillIds = topLevelKeys(skillsBody);
	const translateIds = topLevelKeys(translatesBody);

	if (!characterIds.length) bad("没能从 characters 里解析出角色（解析器可能不适用这份写法）");
	else ok(`角色 ${characterIds.length} 名：${characterIds.join(", ")}`);
	if (!skillIds.length) bad("没能从 skills 里解析出技能");
	else ok(`技能 ${skillIds.length} 个`);

	/* 2a. 角色引用的技能必须都有定义 */
	const refProblemsBefore = problems.length;
	for (const cid of characterIds) {
		const body = extractBlock(charactersBody, cid) || "";
		const m = /skills\s*:\s*\[([^\]]*)\]/.exec(body);
		if (!m) {
			bad(`角色 ${cid} 没有 skills 字段`);
			continue;
		}
		const refs = m[1]
			.split(",")
			.map((s) => s.trim().replace(/["'`]/g, ""))
			.filter(Boolean);
		for (const rid of refs) {
			if (!skillIds.includes(rid)) bad(`角色 ${cid} 引用了不存在的技能 ${rid}`);
		}
	}
	/* 只在确实没发现问题时才报通过：这一节是「结论」不是「已执行」 */
	if (characterIds.length && problems.length === refProblemsBefore) {
		ok("角色引用的技能全部有定义");
	}

	/* 2a-2. 国战字段：值必须是五种内置势力；用到了就必须声明 mode（引擎行为，不是风格偏好） */
	const GZ_GROUPS = new Set(["wei", "shu", "wu", "qun", "jin"]);
	let gzUse = 0;
	for (const cid of characterIds) {
		const body = extractBlock(charactersBody, cid) || "";
		const gz = /groupInGuozhan\s*:\s*["'`]([a-z]+)["'`]/.exec(body);
		const dg = /doubleGroup\s*:\s*\[([^\]]*)\]/.exec(body);
		if (!gz && !dg) continue;
		gzUse++;
		if (gz && !GZ_GROUPS.has(gz[1])) {
			bad(
				`角色 ${cid} 的 groupInGuozhan 是 "${gz[1]}" —— 国战只认 魏蜀吴群晋，` +
					`写别的引擎转换 tag 时会静默丢弃`,
			);
		}
		if (dg) {
			const vals = dg[1]
				.split(",")
				.map((s) => s.trim().replace(/["'`]/g, ""))
				.filter(Boolean);
			const badVals = vals.filter((v) => !GZ_GROUPS.has(v));
			if (badVals.length) {
				bad(`角色 ${cid} 的 doubleGroup 含非法势力（${badVals.join("、")}）—— 国战只认 魏蜀吴群晋`);
			}
			if (badVals.length === 0 && vals.length < 2) {
				bad(`角色 ${cid} 的 doubleGroup 只有 ${vals.length} 个势力 —— 多势力至少两个，单势力直接用 group`);
			}
		}
	}
	if (gzUse) {
		if (/mode\s*:\s*["'`]guozhan["'`]/.test(src)) {
			ok(`国战字段用在 ${gzUse} 名角色上，packs 已声明 mode: "guozhan"`);
		} else {
			bad(
				`有 ${gzUse} 名角色带国战字段，但 packs 里没有 mode: "guozhan" —— ` +
					`国战里选不到这些武将（写法见规范 7.5）`,
			);
		}
	}

	/* 2a-3. 宗族：角色写 clans、技能标 clanSkill，两边要能对上（官方宗族篇机制） */
	const clanNames = new Set();
	for (const cid of characterIds) {
		const body = extractBlock(charactersBody, cid) || "";
		const m = /clans\s*:\s*\[([^\]]*)\]/.exec(body);
		if (!m) continue;
		const vals = m[1]
			.split(",")
			.map((s) => s.trim().replace(/["'`]/g, ""))
			.filter(Boolean);
		if (!vals.length) {
			bad(`角色 ${cid} 的 clans 是空数组 —— 要么删掉，要么填宗族名`);
			continue;
		}
		vals.forEach((v) => clanNames.add(v));
	}
	const clanSkillIds = [];
	for (const sid of skillIds) {
		const body = extractBlock(skillsBody, sid) || "";
		if (/(^|[\s{,(])clanSkill\s*:\s*true/.test(body)) clanSkillIds.push(sid);
	}
	if (clanSkillIds.length && !clanNames.size) {
		bad(
			`技能 ${clanSkillIds.join("、")} 标了宗族技，但没有任何角色写 clans —— ` +
				`同宗共享的效果拿不到判断依据（宗族写法见规范 7.6）`,
		);
	}
	if (clanNames.size) {
		ok(`宗族：${[...clanNames].join("、")}${clanSkillIds.length ? `（宗族技 ${clanSkillIds.length} 个）` : ""}`);
	}

	/* 先收集"子技能"：它们由 subSkill / group 展开而来，
	 * 不单独挂 translate 键，也不该被当成独立技能要求翻译 —— 否则全是误报。 */
	const subSkillNames = new Set();
	for (const sid of skillIds) {
		const body = extractBlock(skillsBody, sid) || "";

		const sub = extractBlock(body, "subSkill");
		if (sub) {
			/* subSkill 的键会展开成 `<技能名>_<键名>` 这样的技能 id */
			for (const key of topLevelKeys(sub)) subSkillNames.add(`${sid}_${key}`);
		}

		const gm = /(^|\n)[\t ]*group\s*:\s*\[([^\]]*)\]/.exec(body);
		if (gm) {
			for (const g of gm[2].split(",")) {
				const name = g.trim().replace(/["'`]/g, "");
				if (name) subSkillNames.add(name);
			}
		}
	}
	/* 还有一类子技能：名字是「父技能 id + _后缀」（例如 lu_xuanzheng_spade），
	 * 由父技能用模板字符串动态 markSkill 引用，同样不需要独立翻译键。 */
	for (const sid of skillIds) {
		const parent = skillIds.find((p) => p !== sid && sid.startsWith(p + "_"));
		if (parent) subSkillNames.add(sid);
	}

	if (subSkillNames.size) ok(`识别到 ${subSkillNames.size} 个子技能（不参与翻译键检查）`);

	/* 2b. 翻译键 */
	for (const cid of characterIds) {
		if (!translateIds.includes(cid)) bad(`角色 ${cid} 缺少 translate 显示名`);
	}
	let missingTranslate = 0;
	for (const sid of skillIds) {
		if (subSkillNames.has(sid)) continue; /* 子技能不要求 */
		if (!translateIds.includes(sid)) {
			bad(`技能 ${sid} 缺少 translate 名`);
			missingTranslate++;
		}
		if (!translateIds.includes(`${sid}_info`)) {
			bad(`技能 ${sid} 缺少 ${sid}_info 描述`);
			missingTranslate++;
		}
	}
	if (!missingTranslate) ok("翻译键齐全（角色名 / 技能名 / 技能 _info）");

	/* 2c. 头像 */
	let missingAvatar = 0;
	for (const cid of characterIds) {
		const hasJpg = existsSync(join(extDir, `${cid}.jpg`));
		const hasPng = existsSync(join(extDir, `${cid}.png`));
		if (!hasJpg && !hasPng) {
			bad(`角色 ${cid} 缺少头像文件 ${cid}.jpg`);
			missingAvatar++;
		}
	}
	if (characterIds.length && !missingAvatar) ok("角色头像文件齐全");

	/* 2d. characterSort */
	if (characterIds.length) {
		const sortStr = sortBody || src;
		const missing = characterIds.filter((cid) => !sortStr.includes(cid) && !translateIds.includes(cid));
		if (!sortStr.includes(extName) && sortBody !== null) {
			/* 不强求，只提示 */
		}
		if (missing.length) bad(`角色未出现在 characterSort：${missing.join(", ")}`, "警告");
		else ok("角色都已出现在 characterSort 或翻译里");
	}

	/* ── 2e. packs 结构（补盲区）────────────────────────────────────────
	 * 真实发生过一次：把 packs 写成平铺的 `{ characters, skills, translates, ... }`，
	 * 语法检查过、跨表一致性也过，但引擎加载时武将根本不出现。
	 * 所以这一项是照「能跑的样本」反推结构约束，而不是照"什么合理"去设计。 */
	section("packs 结构");

	if (!/export\s+const\s+packs\s*=/.test(src)) {
		bad("character.js 里没有 `export const packs` —— 引擎不会加载这个扩展");
	} else {
		const packsBody = extractBlock(src, "packs");

		if (!packsBody) {
			bad("解析不出 packs 的内容，请人工确认结构");
		} else {
			const topKeys = topLevelKeys(packsBody);

			/* ① 必须是两层分组，不能平铺 */
			for (const need of ["character", "skill"]) {
				if (!topKeys.includes(need)) {
					bad(
						`packs 缺少「${need}」分组 —— 正确写法是两层结构：` +
							`{ character: { connect, character, characterSort, characterTitle, translate }, ` +
							`skill: { skill, translate } }`,
					);
				}
			}

			/* ② packs.character 必备键 */
			const charGroup = extractBlock(packsBody, "character");
			if (charGroup) {
				const charKeys = topLevelKeys(charGroup);
				const needChar = {
					connect: "联机将池开关，缺了它联机时选不到",
					character: "角色表",
					characterSort: "武将分拣",
					translate: "翻译表",
				};
				for (const [key, why] of Object.entries(needChar)) {
					/* 简写属性（`characterSort,` 这种没冒号的）topLevelKeys 抓不到，
					 * 所以再按"这个词是否作为键出现过"兜一层，避免误报。 */
					const appearsAsKey =
						charKeys.includes(key) || new RegExp(`(^|[\\s{,(])${key}\\s*[,}\\n]`).test(charGroup);
					if (!appearsAsKey) bad(`packs.character 缺少 ${key}（${why}）`);
				}
				if (/connect\s*:\s*false/.test(charGroup)) {
					bad("packs.character.connect 是 false —— 联机时这个武将包不会被加载");
				}
			}

			/* ③ packs.skill 必备键 */
			const skillGroup = extractBlock(packsBody, "skill");
			if (skillGroup) {
				const skillKeys = topLevelKeys(skillGroup);
				if (!skillKeys.includes("skill")) bad("packs.skill 缺少 skill（技能表）");
				if (!skillKeys.includes("translate")) bad("packs.skill 缺少 translate");
			}

			/* ④ characterSort 第一层 key 必须是扩展名 */
			if (sortBody) {
				const sortKeys = topLevelKeys(sortBody);
				if (!sortKeys.includes(extName)) {
					bad(
						`characterSort 第一层 key 必须是扩展名「${extName}」，当前是：${sortKeys.join(", ") || "(空)"}\n` +
							`     正确写法：characterSort = { ${extName}: { <分组id>: [<角色id>...] } }`,
					);
				} else {
					ok(`characterSort 第一层 key 与扩展名一致（${extName}）`);
				}
			}

			/* ⑤ 分组显示名 */
			if (!extractBlock(src, "characterSortTranslate")) {
				bad("缺少 characterSortTranslate（分组显示名）—— 缺了分组会显示成英文 id", "警告");
			}

			/* ⑥ 武将包自己的显示名 */
			const pkgNameRe = new RegExp(`(^|\\n)[\\t ]*["'\`]?${extName}["'\`]?\\s*:`);
			if (!pkgNameRe.test(packsBody) && !(translatesBody && pkgNameRe.test(translatesBody))) {
				bad(`translate 里缺武将包显示名「${extName}」—— 缺了「武将」页会显示成英文`, "警告");
			}
		}
	}

	/* ── 2f. 扩展名四处一致 ─────────────────────────────────────────────
	 * 引擎按 extension.js 的 name 去找同名文件夹；对不上就整个加载失败。 */
	section("扩展名四处一致");

	const nameSources = { 文件夹名: extName };

	const extSrc = existsSync(extFile) ? await readFile(extFile, "utf8") : "";
	const mExtName = /(^|\n)[\t ]*name\s*:\s*["'`]([^"'`]+)["'`]/.exec(extSrc);
	if (mExtName) nameSources["extension.js"] = mExtName[2];

	if (existsSync(infoFile)) {
		try {
			const info = JSON.parse(await readFile(infoFile, "utf8"));
			if (info && info.name) nameSources["info.json"] = String(info.name);
		} catch {
			bad("info.json 不是合法 JSON");
		}
	}

	/* characterSort 只在「不含扩展名」时才算不一致（它可能同时挂着别的键） */
	if (sortBody) {
		const k = topLevelKeys(sortBody);
		if (k.length && !k.includes(extName)) nameSources["characterSort"] = k.join(" / ");
	}

	const nameValues = Object.values(nameSources);
	if (nameValues.every(v => v === nameValues[0])) {
		ok(`四处一致：${nameValues[0]}`);
	} else {
		bad(
			"扩展名不一致（引擎按 extension.js 的 name 找文件夹，对不上就加载失败）：\n" +
				Object.entries(nameSources)
					.map(([k, v]) => `     ${k} = ${v}`)
					.join("\n"),
		);
	}

	/* ── 3. 技能类型字段（实战发生过的问题）───────────────────────────────── */
	section("技能类型字段");
	let lockedWithoutForced = 0;
	let hasClanSkillNoFlag = 0;

	for (const sid of skillIds) {
		/* 只看技能自身：子技能的 locked/forced 不算，否则父子字段会互相干扰 */
		const body = stripSubSkills(extractBlock(skillsBody, sid) || "");
		const isLocked = /(^|[\s{,(])locked\s*:\s*true/.test(body);
		const isForced = /(^|[\s{,(])forced\s*:\s*true/.test(body);
		if (isLocked && !isForced) {
			lockedWithoutForced++;
			bad(`技能 ${sid} 是 locked 但没有 forced —— 会变成"可被拒绝的锁定技"`);
		}
		/* 宗族技：描述里提到宗族但没 clanSkill 标签 */
		if (/宗族/.test(body) && !/clanSkill\s*:\s*true/.test(body)) {
			hasClanSkillNoFlag++;
			bad(`技能 ${sid} 描述含「宗族」但没有 clanSkill: true`, "警告");
		}
	}
	if (!lockedWithoutForced) ok("没有发现「locked 缺 forced」的技能");
	if (!hasClanSkillNoFlag) ok("宗族技标签检查通过");

	/* ── 3a2. 视为技的 AI 响应标记 ──────────────────────────────────────
	 * 把一张牌「当作【闪】/【桃】/【杀】使用」的技能，如果没写 ai.respondShan /
	 * respondTao / respondSha，AI 只查手牌 → 以为没牌可出 → **直接放弃响应**。
	 * 玩家手操完全正常，所以手工测试根本发现不了。
	 *
	 * 这条不靠文档提醒：文档写了 AI 也可能不读、读了也可能忘；
	 * 只有每次检查都跑一遍才是真的兜住。（2026-10-18 用户指出：不该要求用户提醒） */
	section("视为技的 AI 响应标记");
	const NEED_AI = {
		shan: { keys: ["respondShan"], why: "手里没【闪】时不会尝试用它响应" },
		tao: { keys: ["respondTao", "save"], why: "濒死时不会尝试用它自救或救人" },
		jiu: { keys: ["save"], why: "濒死时不会尝试用它自救" },
		sha: { keys: ["respondSha"], why: "回合外手里没【杀】时不会尝试用它响应" },
	};
	let viewAsChecked = 0;
	let viewAsMissing = 0;
	for (const sid of skillIds) {
		const body = extractBlock(skillsBody, sid) || "";
		const viewAsBody = extractBlock(body, "viewAs");
		if (!viewAsBody) continue;
		const vm = viewAsBody.match(/\bname\s*:\s*["']([a-zA-Z0-9_]+)["']/);
		if (!vm) continue;
		const need = NEED_AI[vm[1]];
		if (!need) continue;
		viewAsChecked++;
		/* 只在技能自己的 ai 块里找 —— 子技能的 ai 不算 */
		const aiBody = extractBlock(stripSubSkills(body), "ai") || "";
		const has = need.keys.some((k) => new RegExp(`\\b${k}\\s*:\\s*true`).test(aiBody));
		if (!has) {
			viewAsMissing++;
			bad(
				`技能 ${sid} 视为「${vm[1]}」，但没有 ai.${need.keys.join(" / ")} —— AI ${need.why}`,
				"警告",
			);
		}
	}
	if (!viewAsMissing) {
		ok(viewAsChecked ? `视为技响应标记检查通过（${viewAsChecked} 个）` : "没有需要响应标记的视为技");
	}

	/* ── 3a3. 有 enable / trigger 却没有 ai ──────────────────────────────
	 * `ai` 不是必填，但**主动技和非强制触发技**缺了它，AI 操控时就不知道该怎么用
	 * （视为技的后果最重，见上一节）。forced 的技能由引擎强制发动，不经 AI 判断，
	 * 所以不报 —— 否则几乎每个锁定技都会刷一条，警告就没人看了。 */
	section("ai 字段缺失");
	let noAiCount = 0;
	for (const sid of skillIds) {
		const body = stripSubSkills(extractBlock(skillsBody, sid) || "");
		const hasHook = /(^|[\s{,(])enable\s*:/.test(body) || /(^|[\s{,(])trigger\s*:/.test(body);
		if (!hasHook) continue;
		/* forced 的技能：发不发由引擎决定，不靠 AI 判断 */
		if (/(^|[\s{,(])forced\s*:\s*true/.test(body)) continue;
		if (/(^|[\s{,(])ai\s*:/.test(body)) continue;
		noAiCount++;
		bad(`技能 ${sid} 有 enable / trigger 但没有 ai —— AI 操控时缺少决策依据`, "警告");
	}
	if (!noAiCount) ok("需要 ai 的技能都写了（forced 的已排除）");

	/* ── 3a4. gaintag 的 eternal_ 前缀 ───────────────────────────────────
	 * 引擎在牌移动处会删掉**所有非 `eternal_` 开头**的 gaintag
	 * （`content.js:12012` / `12074`），所以牌面标记只在当回合可见。
	 * 症状是"标记莫名其妙消失"，不报错、玩家只会觉得"这技能时灵时不灵"。
	 * 只查字面量；传变量的情况静态判断不了，跳过（不误报）。 */
	section("gaintag 的 eternal_ 前缀");
	{
		const jsFiles = [];
		async function walkJs(dir) {
			const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
			for (const e of entries) {
				const p = join(dir, e.name);
				if (e.isDirectory()) {
					if (!p.includes("node_modules")) await walkJs(p);
				} else if (e.name.endsWith(".js")) {
					jsFiles.push(p);
				}
			}
		}
		await walkJs(extDir);

		let tagChecked = 0;
		let tagBad = 0;
		for (const f of jsFiles) {
			const txt = await readFile(f, "utf-8").catch(() => "");
			for (const m of txt.matchAll(/addGaintag\s*\(\s*(["'])([^"']+)\1/g)) {
				tagChecked++;
				if (!m[2].startsWith("eternal_")) {
					tagBad++;
					bad(
						`gaintag「${m[2]}」没有 eternal_ 前缀（${basename(f)}）—— 牌一移动这个标记就会被清掉`,
						"警告",
					);
				}
			}
		}
		if (!tagBad) {
			ok(tagChecked ? `gaintag 前缀检查通过（${tagChecked} 处）` : "没有用到 addGaintag");
		}
	}

	/* ── 3b. 时机名核实 ───────────────────────────────────────────────
	 * 时机名写错的后果是「技能永远不会触发」，而且不报任何错 ——
	 * 静态语法查不出来，只有对着引擎源码核一遍才看得见。 */
	section("时机名核实");

	if (!existsSync(engineRoot)) {
		bad("引擎源码根不存在，跳过时机名检查", "警告");
	} else {
		/* trigger 里除了时机名还写着 role（player/target/global…），要排除掉 */
		const ROLE_NAMES = new Set(["player", "target", "global", "source", "skill", "state"]);
		const timingNames = new Set();

		for (const sid of skillIds) {
			const body = extractBlock(skillsBody, sid) || "";
			const triggerBody = extractBlock(body, "trigger");
			if (!triggerBody) continue;
			for (const m of triggerBody.matchAll(/["'`]([a-zA-Z_$][\w$]*)["'`]/g)) {
				if (!ROLE_NAMES.has(m[1])) timingNames.add(m[1]);
			}
		}

		if (!timingNames.size) {
			ok("没解析出时机名（写法可能特殊，此次跳过）");
		} else {
			const found = await engineHasWord(join(engineRoot, "src"), [...timingNames]);
			const missing = [...timingNames].filter((n) => !found.has(n));

			if (missing.length) {
				bad(
					`以下时机名在引擎源码里找不到，相关技能可能永远不会触发：\n     ${missing.join(", ")}`,
					"错误",
				);
			} else {
				ok(`${timingNames.size} 个时机名均能在引擎源码中找到`);
			}
		}
	}

	/* ── 3c. 描述与实现一致性 ─────────────────────────────────────────
	 * 王朗那个「锁定技不锁定」的坑，本质是描述与字段不一致：
	 * 锁定技标签本身不决定是否强制，关键看描述里有没有「可」字。
	 * 这条把「描述说可选、字段却强制发动」挑出来。 */
	section("描述与实现一致性");

	let semanticIssues = 0;
	for (const sid of skillIds) {
		/* 只看技能自身：子技能带 forced 不该算到父技能头上 */
		const body = stripSubSkills(extractBlock(skillsBody, sid) || "");
		const info = extractTranslateValue(translatesBody, `${sid}_info`);
		if (!info) continue; /* 没有描述文本，无从比对 */

		/* 去掉 <br> 之类标签，只看纯文本里有没有「可」 */
		const plain = info.replace(/<br\s*\/?>/gi, "").replace(/<[^>]+>/g, "");
		/* 必须是「你可(以)…」这种主语明确的写法才算「可选发动」。
		 * 只用 /可/ 会把「这些牌可根据花色转化」这类描述牌的句子也算进来，
		 * 制造大量误报 —— 宁可漏判，不可误判。 */
		const saysOptional = /你可/.test(plain);
		const isForced = /(^|[\s{,(])forced\s*:\s*true/.test(body);

		if (saysOptional && isForced) {
			bad(
				`技能 ${sid} 描述里有「可」（应询问玩家），却标了 forced: true —— 会强制发动，与描述矛盾`,
				"错误",
			);
			semanticIssues++;
		}
	}
	if (!semanticIssues) ok("描述与 forced 字段没有发现矛盾");

	/* ── 3d. 台词键（`#` 开头） ───────────────────────────────────────
	 * 台词写错**不报错**，只是「武将介绍页里没字」，很难自己发现。
	 * 这里只查两条**确定**的规则，不去推断「这个键到底属于哪个技能/角色」——
	 * 皮肤（`characterSubstitute`）与 `audioname` 会让归属变得很绕，
	 * 猜错就是误报，宁可漏判。
	 * 出处：官方 `docs/audio-guide.md`；消费点 `src/noname/get/audio.ts`（规则见规范 8.1）。 */
	section("台词键");

	let voiceIssues = 0;
	const voiceKeys = topLevelKeys(translatesBody).filter((k) => k.startsWith("#"));

	if (!voiceKeys.length) {
		ok("没有台词键（不写台词不影响加载）");
	} else {
		/* 规则 1：键里不带文件后缀。写 `#wusheng1`，不写 `#wusheng1.mp3` */
		const withExt = voiceKeys.filter((k) => /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(k));
		if (withExt.length) {
			bad(
				`台词键里带了文件后缀：${withExt.map((k) => `"${k}"`).join("、")} —— ` +
					`键写的是音频地址，不带 .mp3 这类后缀，去掉即可`,
				"错误",
			);
			voiceIssues += withExt.length;
		}

		/* 规则 2：同一地址的序号从 1 起、并且连着。
		 * 只有 `#xx3` 而没有 `#xx1` / `#xx2` 时，那一句永远读不到。
		 * 只认「<地址><数字>」这种形式；`ext:` 自定义地址不参与（边界判不出来）。 */
		const badExtKeys = new Set(withExt);
		const voiceGroups = new Map();
		for (const k of voiceKeys) {
			/* 带文件后缀的键已经在上面报过了。放进来还会**误报**：
			 * `#tg_skill1.mp3` 会被切成 base=`tg_skill1.mp`、序号=`1`，
			 * 于是凭空多出一条「缺 #tg_skill1.mp1」。 */
			if (badExtKeys.has(k)) continue;
			const m = /^#([^:]+?)(\d+)(:die)?$/.exec(k);
			if (!m) continue;
			const groupKey = m[1] + (m[3] || "");
			if (!voiceGroups.has(groupKey)) {
				voiceGroups.set(groupKey, { base: m[1], suffix: m[3] || "", nums: [] });
			}
			voiceGroups.get(groupKey).nums.push(Number(m[2]));
		}
		const gapped = [];
		for (const g of voiceGroups.values()) {
			const max = Math.max(...g.nums);
			for (let i = 1; i <= max; i++) {
				if (!g.nums.includes(i)) {
					gapped.push(`#${g.base}${i}${g.suffix}`);
					break;
				}
			}
		}
		if (gapped.length) {
			bad(
				`台词序号断了：缺 ${gapped.join("、")} —— 引擎按 1、2、3 的顺序读，` +
					`断号之后的几句不会被读到`,
				"警告",
			);
			voiceIssues += gapped.length;
		}

		if (!voiceIssues) ok(`${voiceKeys.length} 个台词键的后缀与序号检查通过`);
	}

	/* ── 4. id 撞名 ──────────────────────────────────────────────────── */
	section("id 撞名（对照引擎源码）");

	if (!existsSync(engineRoot)) {
		bad("引擎源码根不存在，跳过撞名检查", "警告");
	} else if (!skillIds.length) {
		/* 解析失败时绝不能往下走：空模式会让 grep 匹配一切，变成一堆假"撞名" */
		bad("没有解析出技能 id，跳过撞名检查", "警告");
	} else {
		const engineCharDir = join(engineRoot, "src", "character");
		if (!existsSync(engineCharDir)) {
			bad("找不到引擎 src/character 目录，跳过撞名检查", "警告");
		} else {
			/* 技能 id 与角色 id 都要查：
			 * · 技能 id 撞名 → init/loading.js 静默 continue，技能永远不触发
			 * · 角色 id 撞名 → init/loading.js 静默丢弃这个新角色（只 console.log
			 *   一句 duplicated），表现为「武将不出现」，比技能撞名更难查 */
			for (const [label, ids] of [
				["技能 id", skillIds],
				["角色 id", characterIds],
			]) {
				if (!ids.length) continue;
				const files = await engineFilesWith(engineCharDir, ids);
				if (!files.length) {
					ok(`${label} 未在引擎源码中出现（撞名风险低）`);
				} else {
					/* grep 命中只说明"出现过"，可能定义也可能被他处引用 —— 从严提示，交人判断 */
					bad(
						`${label} 在引擎源码里出现过（撞名或被他处引用，需人工确认）：\n     ${files
							.slice(0, 6)
							.map((f) => relative(engineRoot, f))
							.join("\n     ")}`,
						"警告",
					);
				}
			}
		}
	}

	/* ── 5. storage 生命周期 ─────────────────────────────────────────── */
	/* 按 storage 键而不是按技能来判：一个技能的 storage 常被另一个技能读写
	 * （例如文伐会重铸辞锋累积的牌）。同时必须区分两类状态：
	 *   · 简单值（数字/布尔）—— 丢了无所谓，不强制 onremove
	 *   · 牌集合 —— 在游戏外时直接 delete 就是凭空消失，必须归还
	 */
	section("storage 生命周期");

	const storageKeys = new Map(); /* key -> { writers, hasInit, hasRemove, removeIsDelete, looksLikeCards } */

	for (const sid of skillIds) {
		const body = extractBlock(skillsBody, sid) || "";
		for (const m of body.matchAll(/player\.storage\.(\w+)/g)) {
			const key = m[1];
			const rec = storageKeys.get(key) || {
				writers: new Set(),
				hasInit: false,
				hasRemove: false,
				removeIsDelete: false,
				looksLikeCards: false,
				hasFallback: false,
			};
			rec.writers.add(sid);

			const around = body.slice(Math.max(0, m.index - 150), m.index + 150);
			/* 只认「往里塞牌对象」的迹象：
			 *   · `= []`         不算 —— 可能是花色数组（lu_xuanzheng 被这条冤枉过）
			 *   · `push(get.name(card))` 不算 —— 那是牌名字符串（chen_wenfa_names 被这条冤枉过） */
			/* 只看该 storage 出现处附近，而不是整个技能块 ——
			 * 同一个技能里可能有别的地方碰牌区（文伐的重铸回调就提到了
			 * cardsGotoOrdering），按整块判断会把「牌名字符串数组」也误判成牌。 */
			const mentionsCardZone = /cardsGotoSpecial|GotoOrdering|ui\.special/.test(around);
			const pushesCardObject = /\.push\(\s*(?!get\.|["'`])/.test(around);
			if (mentionsCardZone || pushesCardObject) rec.looksLikeCards = true;

			/* 有 `|| 默认值` 兜底，就不必强制 init */
			if (new RegExp(`storage\\.${key}\\s*\\|\\|`).test(body)) rec.hasFallback = true;

			if (new RegExp(`init\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{0,900}?storage\\.${key}`).test(body)) rec.hasInit = true;
			if (new RegExp(`(?:async\\s+)?onremove\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{0,900}?storage\\.${key}`).test(body)) {
				rec.hasRemove = true;
				if (new RegExp(`delete\\s+player\\.storage\\.${key}`).test(body)) {
					/* 光有 delete 不能定罪：正确写法是「先取出 → delete 清引用 → 归还牌堆」。
					 * 只有「删了却没还」才算丢牌 —— 否则会把修好的代码又报一遍。 */
					const removeIdx = body.search(/(?:async\s+)?onremove\s*\(/);
					const removeSection = removeIdx >= 0 ? body.slice(removeIdx, removeIdx + 1600) : "";
					const returnsCards =
						/loseToDiscardpile|cardsGotoOrdering|cardsGotoSpecial|recast/.test(removeSection);
					if (!returnsCards) rec.removeIsDelete = true;
				}
			}

			storageKeys.set(key, rec);
		}
	}

	let storageIssues = 0;
	for (const [key, rec] of storageKeys) {
		const who = [...rec.writers].join(" / ");

		if (!rec.hasInit && !rec.hasFallback) {
			bad(`storage.${key}（被 ${who} 使用）既没有 init 初始化，也没看到 \`|| 默认值\` 兜底`, "警告");
			storageIssues++;
		}

		if (rec.looksLikeCards) {
			if (!rec.hasRemove) {
				bad(`storage.${key}（被 ${who}）存的是牌，却没有 onremove —— 技能被移除时这些牌会永久消失`, "错误");
				storageIssues++;
			} else if (rec.removeIsDelete) {
				bad(`storage.${key}（被 ${who}）在 onremove 里直接 delete，但存的是牌 —— 那些牌会永久消失，应当归还牌堆`, "错误");
				storageIssues++;
			}
		}
		/* 简单值不强制 onremove：数字丢了无所谓，硬要求只会制造噪音 */
	}

	if (!storageKeys.size) ok("未发现 storage 使用");
	else if (!storageIssues) ok(`${storageKeys.size} 个 storage 键的初始化与资源归还检查通过`);

	/* ── 6. 引擎 API 存在性 ──────────────────────────────────────────── */
	section("引擎 API 存在性");
	if (existsSync(engineRoot)) {
		const apis = new Set();
		/* 只挑 value 层的方法调用，避免把自定义函数也算进来 */
		for (const m of src.matchAll(/\b(game|player|lib|get|ui|_status)\.([a-zA-Z_]\w*)\s*\(/g)) {
			apis.add(`${m[1]}.${m[2]}`);
		}
		const names = [...apis];
		const missing = [];
		/* 不再按对象分桶：分桶原本是为了少起几次 grep，而且那种写法只要桶里
		 * 有一个方法命中就整桶放过（假阴性）。改成一次扫完所有方法。 */
		const allMethods = [...new Set(names.map((n) => n.split(".")[1]))];
		const srcFiles = await engineFiles(join(engineRoot, "src"));
		const bigText = srcFiles.map((f) => f.text).join("\n");
		const methodRe = new RegExp("(" + allMethods.map(escapeRegExp).join("|") + ")(?=\\s*\\()", "g");
		const present = new Set();
		let hit;
		while ((hit = methodRe.exec(bigText))) present.add(hit[1]);
		for (const n of names) {
			if (!present.has(n.split(".")[1])) missing.push(n);
		}
		if (missing.length) {
			bad(`以下 API 在引擎 src 里找不到同名定义，需人工确认：\n     ${missing.join(", ")}`, "警告");
		} else {
			ok(`扫描的 ${names.length} 个引擎 API 均能在源码中找到同名方法`);
		}
	} else {
		bad("引擎源码根不存在，跳过 API 检查", "警告");
	}

	/* ── 汇总 ────────────────────────────────────────────────────────── */
	console.log("\n" + "═".repeat(60));
	const errors = problems.filter((p) => p.level === "错误");
	const warns = problems.filter((p) => p.level === "警告");
	console.log(`检查完毕：${passes.length} 项通过 / ${errors.length} 项错误 / ${warns.length} 项警告`);

	if (errors.length) {
		console.log("\n必须修的错误：");
		errors.forEach((p, i) => console.log(`  ${i + 1}. [${p.section}] ${p.msg}`));
	}
	if (warns.length) {
		console.log("\n需要人工判断的警告：");
		warns.forEach((p, i) => console.log(`  ${i + 1}. [${p.section}] ${p.msg}`));
	}
	console.log("═".repeat(60));

	process.exit(errors.length ? 1 : 0);
}

main().catch((err) => {
	console.error("检查脚本自身出错：", err);
	process.exit(2);
});