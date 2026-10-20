import { lib, game, ui, get, ai, _status } from "../../../noname.js";

/* ------------------------------------------------------------------ *
 * __武将名__（扩展：__扩展名__）
 *
 * 设计裁决（作者确认后填在这里，便于日后复查）：
 *   ① …
 *   ② …
 *
 * 技能描述一字不改地录入 translates（包括原文可能的笔误）。
 * ------------------------------------------------------------------ */

const characters = {
	__角色id__: {
		sex: "male", // male / female
		group: "qun", // wei / shu / wu / qun / jin / shen
		hp: 3,
		skills: ["__技能id__"],
	},
};

const skills = {
	/* ---------------------------------------------------------------- *
	 * __技能名__
	 * __技能描述__
	 * ---------------------------------------------------------------- */
	__技能id__: {
		// [警告] 锁定技要同时写 locked 与 forced —— locked 只管 UI 标签，
		//    是否强制发动由 forced 决定（漏写会变成「可以被拒绝的锁定技」）
		locked: true,
		forced: true,
		trigger: { player: "__时机名__" },
		filter(event, player) {
			return true;
		},
		async content(event, trigger, player) {
			// 防御式读取：开局/复活/技能转移等路径都可能让 init 没跑到
			if (!Array.isArray(player.storage.__技能id__)) {
				player.storage.__技能id__ = [];
			}
			// 效果写在下面
		},
		mark: true,
		intro: {
			content(storage, player) {
				return "__标记内容__";
			},
		},
		/* -------------------------------------------------------------- *
		 * ai：给 AI 的决策提示（**可省**）
		 *
		 * 不写不影响技能生效、不影响玩家手操；只影响 AI 抽到这个武将时的表现。
		 * 下面几类**必须**写，否则 AI 会犯傻：
		 *   · 视为技当【闪】用      → ai: { respondShan: true }
		 *   · 视为技当【桃】/【酒】用 → ai: { respondTao: true } 或 { save: true }
		 *   · 视为技当【杀】用（回合外响应）→ ai: { respondSha: true }
		 *   · 免疫 / 无视类（"【杀】对你无效"）→ nofire / nothunder / nodamage / unequip
		 *   · 主动技有代价（失体力、弃牌）   → ai: { neg: true }
		 * 锁定技 / forced 触发技一般**不需要**（发不发由 forced 决定，不经 AI 判断）。
		 *
		 * 写法不要自己编：`node scripts/search-skill.mjs <同类官方技能名>` 拿到官方技能 id，
		 * 再去 `src/character/<包>.js` 把它的 `ai: {...}` **整块抄过来**。
		 * -------------------------------------------------------------- */
		// ai: { respondShan: true },

		init(player, skill) {
			player.storage.__技能id__ = [];
		},
		onremove(player, skill) {
			// [警告] 区分「可丢弃的状态」与「必须归还的资源」：
			//    若 storage 里存的是游戏外的牌，直接 delete 会让它们永久消失，
			//    应该先取出来放回弃牌堆。
			delete player.storage.__技能id__;
		},
	},

	/* ────────────────────────────────────────────────────────────────── *
	 * 【主动技骨架】用到了就把整段注释解开、改字段。
	 * 下面是「出牌阶段，你可以将一张 ♥ 牌当【杀】使用」这种最常见的形式。
	 *
	 * 纯效果型主动技（不转化牌，只是「出牌阶段你可以…」）：
	 *   去掉 viewAs / filterCard / selectCard / position，content 里直接做事。
	 * 要指定目标的：在 content 里 await player.chooseTarget({...}).forResult()。
	 * ---------------------------------------------------------------- */
	// __主动技id__: {
	// 	enable: "phaseUse",             // 出牌阶段可用（其它取值见技能系统 §4）
	// 	usable: 1,                      // 描述没说「限一次」就别加这一行
	// 	filterCard(card) {              // 哪些牌能当素材
	// 		return get.suit(card) === "heart";
	// 	},
	// 	selectCard: [1, 1],             // 要几张；不写默认 1 张
	// 	position: "hand",               // 只从手牌选；不写则手牌 + 装备都能选
	// 	filterTarget(card, player, target) { return target !== player; },  // 选目标的条件（要指定目标才写）
	// 	selectTarget: 1,                // 选几个目标（不写默认 1 个）
	// 	viewAs: { name: "sha" },        // 「当什么用」—— 这一行让它成为转化技
	// 	ai: { respondSha: true },       // 视为【闪】/【杀】/【桃】时必须写，见上方 ai 段
	// 	async content(event, trigger, player) {
	// 		// 转化技的 content 通常留空 —— 牌怎么用由引擎走；
	// 		// 「然后你摸一张牌」这类附加效果写在这里。
	// 	},
	// },
};

const translates = {
	__角色id__: "__武将显示名__",
	__角色id___ab: "__武将简称__",

	__技能id__: "__技能名__",
	__技能id___info: "__技能描述（一字不改）__",
	__技能id___bg: "__标记字__",
};

/* 称号（武将牌名下方那行小字） */
const characterTitles = {
	__角色id__: "__称号__",
};

/* [警告] 第一层的 key 必须与扩展名（extension.js 里的 name）一致 */
const characterSort = {
	__扩展名__: {
		__分组id__: ["__角色id__"],
	},
};

/* 分组 id → 分组显示名 */
const characterSortTranslate = {
	__分组id__: "自制武将",
};

export const packs = {
	character: {
		/* 让这个武将包进入联机将池（缺了它联机时选不到） */
		connect: true,
		character: characters,
		characterSort,
		characterTitle: characterTitles,
		translate: {
			...translates,
			...characterSortTranslate,
			/* 武将包在「武将」页显示的名字 */
			__扩展名__: "__扩展名__",
		},
	},
	skill: {
		skill: skills,
		translate: translates,
	},
};