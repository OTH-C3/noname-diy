const characters = {
	tg_hero: {
		sex: "male",
		group: "wei",
		hp: 4,
		skills: ["tg_skill"],
	},
};

const skills = {
	tg_skill: {
		trigger: { player: "damageAfter" },
		forced: true,
		locked: true,
		async content(event, trigger, player) {
			await player.draw();
		},
	},
};

const translates = {
	tg_hero: "测试武将",
	tg_skill: "测试技",
	"tg_skill_info": "锁定技，你受到伤害后，摸一张牌。",
	"#tg_skill1": "摸牌只是顺手。",
	"#tg_skill2": "再来一张，如何？",
	"#tg_hero1:die": "这一局，算我输。",
};

const characterTitles = {
	tg_hero: "试作型",
};

const characterSort = {
	testgood: {
		tg_pack: ["tg_hero"],
	},
};

const characterSortTranslate = {
	tg_pack: "测试包",
};

export const packs = {
	character: {
		connect: true,
		character: characters,
		characterSort,
		characterTitle: characterTitles,
		translate: {
			...translates,
			...characterSortTranslate,
			testgood: "测试扩展",
		},
	},
	skill: {
		skill: skills,
		translate: translates,
	},
};
