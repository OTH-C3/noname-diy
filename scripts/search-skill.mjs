#!/usr/bin/env node
/**
 * 官方技能检索 —— 按中文名 / 关键词查〖技能〗，一次拿到「选哪版 + 能不能直接复用」
 * ============================================================================
 * 用法：
 *   node scripts/search-skill.mjs <关键词> [引擎源码根]
 *
 * 例：
 *   node scripts/search-skill.mjs 探锋
 *   node scripts/search-skill.mjs 铁骑 /path/to/引擎源码
 *
 * 为什么要有它：用户说「做成〖剑合〗那样」时，同名技能常有好几个版本
 * （探锋就有族陆景 / 势夏侯尚 / 十周年夏侯尚 / 国战 四版，效果完全不同），
 * 须先把候选列出交由用户选择；挑完还要判断能不能直接调它的 content ——
 * viewAs 型技能没有 content 可调（逻辑在引擎的「视为使用」流程里），只能自己复刻。
 *
 * 找不到引擎源码根时只输出速查里的信息（没有文件行号与 content/viewAs 判断）。
 * ==========================================================================*/

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, "..", "references", "skills");

const positional = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const keyword = positional[0];
const engineRoot = positional[1] ? resolve(positional[1]) : findEngineRoot();

if (!keyword) {
	console.error("用法：node scripts/search-skill.mjs <关键词> [引擎源码根]");
	process.exit(2);
}

function findEngineRoot() {
	let dir = process.cwd();
	for (let i = 0; i < 6; i++) {
		for (const name of ["引擎源码", "resources/app", ""]) {
			const p = name ? join(dir, name) : dir;
			if (existsSync(join(p, "src", "noname"))) return p;
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return null;
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ── 1. 从速查里把条目抠出来 ────────────────────────────────────────────
 * 格式（生成脚本产物，勿手改）：
 *   ### 技能名
 *   - **包 · 武将 · 类型** `技能id`
 *     描述正文……
 */
async function collectEntries() {
	const files = (await readdir(SKILLS_DIR)).filter((f) => f.startsWith("技能速查") && f.endsWith(".md"));
	const names = [];
	for (const f of files.sort()) {
		const text = await readFile(join(SKILLS_DIR, f), "utf-8");
		for (const block of text.split(/^### /m).slice(1)) {
			const lines = block.split("\n");
			const name = lines[0].trim();
			const entries = [];
			let cur = null;
			for (const raw of lines.slice(1)) {
				const line = raw.trim();
				const m = /^- \*\*(.+?)\*\* `([^`]+)`\s*$/.exec(line);
				if (m) {
					cur = { meta: m[1], id: m[2], desc: "" };
					entries.push(cur);
				} else if (cur && line && !line.startsWith("#")) {
					cur.desc += (cur.desc ? " " : "") + line;
				}
			}
			if (entries.length) names.push({ name, entries });
		}
	}
	return names;
}

/* ── 2. 引擎源码检索（纯 Node，不依赖系统 grep）───────────────────────── */
const _cache = new Map();

async function engineFiles(root) {
	const key = resolve(root);
	if (_cache.has(key)) return _cache.get(key);
	const out = [];
	const walk = async (dir, depth) => {
		if (depth > 12) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
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
	_cache.set(key, out);
	return out;
}

/* 从 `{` 处做括号配对，返回技能对象那块文本 */
function blockAt(text, openIdx) {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		const c = text[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return text.slice(openIdx, i + 1);
		}
	}
	return text.slice(openIdx, Math.min(text.length, openIdx + 4000));
}

/* 定位一个技能 id：定义文件、行号，以及它能不能被直接复用。
 * 两个根都要搜：有的包只在编译产物目录（<引擎根>/character）里有代码，
 * src 树里没有 —— 反馈里提过「src/character/* 与编译产物 character/* 混着放」。
 * 命中的是哪一边会标出来（引用时一律用 src/…，行号对不上）。 */
async function locate(id) {
	if (!engineRoot) return null;
	const roots = [
		{ dir: join(engineRoot, "src", "character"), from: "src" },
		{ dir: join(engineRoot, "character"), from: "编译产物" },
	];
	const re = new RegExp(`(^|[\\s,{])["']?${escapeRegExp(id)}["']?\\s*:\\s*\\{`, "m");
	for (const { dir, from } of roots) {
		if (!existsSync(dir)) continue;
		const files = await engineFiles(dir);
		for (const f of files) {
			const m = re.exec(f.text);
			if (!m) continue;
			const brace = f.text.indexOf("{", m.index);
			const block = blockAt(f.text, brace);
			return {
				file: relative(engineRoot, f.path),
				line: f.text.slice(0, m.index).split("\n").length,
				from,
				content: /(^|\n)\s*(async\s+)?content\s*[:(]/.test(block),
				viewAs: /(^|\n)\s*viewAs\s*:/.test(block),
				trigger: /(^|\n)\s*trigger\s*:/.test(block),
				enable: /(^|\n)\s*enable\s*:/.test(block),
			};
		}
	}
	return null;
}

/* ── 3. 跑 ────────────────────────────────────────────────────────────── */
const all = await collectEntries();
const byName = all.filter((n) => n.name.includes(keyword) || n.entries.some((e) => e.id.includes(keyword)));
const byDesc = byName.length
	? []
	: all.filter((n) => n.entries.some((e) => e.desc.includes(keyword))).slice(0, 12);

const result = byName.length ? byName : byDesc;
if (!result.length) {
	console.log(`没找到含「${keyword}」的技能。`);
	/* **未收录 ≠ 不存在** —— 速查表是从官方包里抽的，国战 / 手杀 / 特殊模式的技能
	 * 可能整包没进来（实测：国战陆逊的「度势」搜不到，但游戏里确实有这个技能）。
	 * 所以没命中时要把"下一步去哪儿找"说清楚，别让人以为这技能不存在。 */
	console.log("提示：速查覆盖 3790 个技能名；未收录不等于不存在 —— 国战 / 手杀 / 特殊模式的技能可能整包没进表。");
	console.log("接着试：① grep references/skills/ 里的描述正文；② 在游戏目录里搜技能名或 id：");
	console.log("  grep -rn \"<关键词>\" <游戏目录>/resources/app/character/ | head");
	console.log("③ 仍找不到就问用户：技能出自哪个包 / 哪个武将。");
	process.exit(0);
}

const total = result.reduce((n, r) => n + r.entries.length, 0);
console.log(
	byName.length
		? `命中 ${result.length} 个技能名、${total} 个版本${engineRoot ? "" : "（未找到引擎源码，缺文件行号与复用判断）"}\n`
		: `没有技能名命中，以下是描述里提到「${keyword}」的 ${result.length} 个（最多列 12 个）\n`,
);

for (const { name, entries } of result) {
	console.log(`### ${name}`);
	for (const e of entries) {
		const loc = await locate(e.id);
		const tags = loc
			? [
					loc.content ? "content: 有" : "content: 无",
					loc.viewAs ? "viewAs: 有" : "",
					loc.trigger ? "trigger" : "",
					loc.enable ? "enable" : "",
				]
					.filter(Boolean)
					.join("  ")
			: "";
		console.log(`- ${e.meta}  \`${e.id}\``);
		if (loc) {
			const fromTag = loc.from === "src" ? "" : "（编译产物，行号与 src 不同）";
			console.log(`    ${tags}    ${loc.file}:${loc.line} ${fromTag}`.trimEnd());
		} else if (engineRoot) {
			console.log("    （两个根里都没定位到定义：可能由别处引用、或只在 audio / 技能列表里出现）");
		}
		console.log(`    ${e.desc.slice(0, 80)}${e.desc.length > 80 ? "…" : ""}`);
	}
	console.log();
}

console.log("读法：");
console.log("  `content: 有` → 可以用 game.createEvent(id) + setContent(get.info(id).content) 直接复用；");
console.log("  `content: 无` 且 `viewAs: 有` → 逻辑在引擎的「视为使用」流程里，**不能直接调**，只能照描述复刻；");
console.log("  同名多版本效果可能完全不同 —— **先把候选发给用户让他选**，不要自己挑一个。");
if (engineRoot) console.log(`\n引擎源码：${engineRoot}`);
