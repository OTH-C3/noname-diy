#!/usr/bin/env node
/**
 * 官方技能速查 · 第一步：从引擎源码提取技能数据
 * ============================================================================
 * 用途：扫引擎源码 character/**，把每个包里的 translate 表（技能名 / 描述）
 *      与 characters 表（武将 → 技能）取出来，落成一份中间 JSON。
 *      第二步由 build-skill-doc.py 把它整理成 references/skills/ 下的速查文档。
 *
 * 用法：
 *   node scripts/extract-skills.mjs <引擎源码根> [输出.json]
 *   （引擎源码根也可用环境变量 DIY_ENGINE_ROOT 指定；不可省略）
 *
 * 为什么用 vm 求值而不是正则：translate 是 ESM + 模板字符串
 *   （含 ${get.poptip("id")}），正则拆不干净。这里剥掉 import/export 后
 *   在沙箱里真跑一遍，直接拿到对象。
 *
 * 输出 JSON 结构：
 *   { translates: {key: {text, pack, file}}, characters: {id: {def, pack, file}},
 *     heroesOf: {技能id: [武将id]}, errors: [...] }
 * ==========================================================================*/

import fs from "fs";
import path from "path";
import vm from "vm";

const ROOT = process.argv[2] || process.env.DIY_ENGINE_ROOT;
if (!ROOT) {
	console.error("用法：node scripts/extract-skills.mjs <引擎源码根> [输出.json]");
	console.error("  引擎源码根 = 含 character/ game/ noname/ 与 noname.js 的目录");
	process.exit(2);
}
const OUTJSON = process.argv[3] || "skills_raw.json";
const CHAR = path.join(ROOT, "character");

if (!fs.existsSync(CHAR)) {
	console.error("找不到 " + CHAR + " —— 引擎源码根给错了？（应指向含 character/ 的目录）");
	process.exit(2);
}

const noop = () => {};
let deep;
function makeDeep() {
	if (deep) return deep;
	const fn = function () { return deep; };
	deep = new Proxy(fn, {
		get(t, k) {
			if (k === Symbol.toPrimitive) return () => "";
			if (k === Symbol.iterator) return function* () {};
			if (k === "toString" || k === "valueOf") return () => "";
			if (k === "then") return undefined;   // 别被当成 thenable
			return deep;
		},
		apply: () => deep,
		construct: () => deep,
		has: () => true,
	});
	return deep;
}

function makeCtx() {
	const d = makeDeep();
	const ctx = {
		// poptip 有字符串与对象两种传参，对象取 name —— 否则描述里会留 [object Object]
		get: { poptip: (x) => "〖" + (typeof x === "string" ? x : (x && x.name) || "?") + "〗" },
		lib: d, game: d, ui: d, ai: d, _status: {}, str: "",
		Array, Object, Math, JSON, String, Number, Boolean, RegExp, Date, Set, Map,
		console: { log: noop, warn: noop, error: noop },
	};
	ctx.globalThis = ctx;
	return ctx;
}

function strip(src) {
	return src
		.replace(/^\s*import\s[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm, "")
		.replace(/^\s*export\s+default\s+\w+\s*;?\s*$/gm, "")
		.replace(/^(\s*)export\s+/gm, "$1");
}

function tryExtract(file, varName) {
	const src = strip(fs.readFileSync(file, "utf8"));
	try {
		const v = vm.runInNewContext(src + "\n;" + varName, makeCtx(), { timeout: 30000 });
		if (v && typeof v === "object" && !Array.isArray(v)) return v;
		return null;
	} catch (e) {
		return { __err: e.message.slice(0, 100) };
	}
}

function walk(dir) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else if (e.name.endsWith(".js")) out.push(p);
	}
	return out;
}

const translates = {};   // key -> { text, pack, file }
const characters = {};   // id  -> { def, pack, file }
const errors = [];

for (const f of walk(CHAR)) {
	const src = fs.readFileSync(f, "utf8");
	const rel = path.relative(CHAR, f);
	const pack = rel.includes(path.sep) ? rel.split(path.sep)[0] : rel.replace(/\.js$/, "");

	// 只看**顶格**的 const 声明 —— 函数体里的局部同名变量不算
	// （offline/skill/*.js 里有 `const characters = info.getCharacters(...)`）
	if (/^const\s+translates\s*=/m.test(src)) {
		const t = tryExtract(f, "translates");
		if (t && !t.__err) {
			for (const [k, v] of Object.entries(t)) {
				if (typeof v !== "string") continue;
				if (!(k in translates)) translates[k] = { text: v, pack, file: rel };
			}
		} else errors.push(rel + " [translates] " + (t && t.__err ? t.__err : "null"));
	}

	if (/^const\s+characters\s*=/m.test(src)) {
		const c = tryExtract(f, "characters");
		if (c && !c.__err) {
			for (const [k, v] of Object.entries(c)) {
				if (v && typeof v === "object") characters[k] = { def: v, pack, file: rel };
			}
		} else errors.push(rel + " [characters] " + (c && c.__err ? c.__err : "null"));
	}
}

const heroesOf = {};
for (const [hid, { def }] of Object.entries(characters)) {
	const sk = Array.isArray(def.skills) ? def.skills : [];
	for (const s of sk) {
		if (typeof s !== "string") continue;
		(heroesOf[s] = heroesOf[s] || []).push(hid);
	}
}

fs.writeFileSync(OUTJSON,
	JSON.stringify({ translates, characters, heroesOf, errors }, null, 1), "utf8");

console.log("translates 条目：", Object.keys(translates).length);
console.log("  其中 _info 结尾：", Object.keys(translates).filter((k) => k.endsWith("_info")).length);
console.log("characters 武将：", Object.keys(characters).length);
console.log("被武将引用的技能 id：", Object.keys(heroesOf).length);
console.log("提取失败：", errors.length);
for (const e of errors) console.log("  " + e);
console.log("→ 中间产物：" + OUTJSON + "（下一步交给 build-skill-doc.py）");
