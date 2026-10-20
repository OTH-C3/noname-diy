const characters = {
	tb_hero: {
		sex: "male",
		group: "wei",
		hp: 4,
		skills: ["tb_skill", "tb_missing"],
	},
};

const skills = {
	tb_skill: {
		trigger: { player: "damageAfter" },
		async content(event, trigger, player) {
			await player.draw();
		},
	},
};

const translates = {
	tb_hero: "坏样本武将",
	tb_skill: "坏样本技",
	/* 故意写坏：台词键不该带文件后缀（官方 audio-guide 明确说了） */
	"#tb_skill1.mp3": "带上后缀就永远读不到",
	/* 故意写坏：序号从 3 起，前两句读不到 */
	"#tb_hero3:die": "断号的阵亡台词",
};

export const packs = {
	character: {
		character: characters,
		characterSort: {
			名字不对: { tb_pack: ["tb_hero"] },
		},
		characterTitle: { tb_hero: "试作型" },
		translate: { ...translates, 名字不对: "错名字" },
	},
	skill: {
		skill: skills,
		translate: translates,
	},
};
