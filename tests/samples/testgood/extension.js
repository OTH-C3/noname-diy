import { lib, game, ui, get, ai, _status } from "../../noname.js";
import { packs } from "./character/character.js";

export const type = "extension";

export default function () {
	return {
		name: "testgood",
		connect: true,
		content(config, pack) {},
		config: {},
		help: {},
		package: {
			...packs,
			author: "test",
			intro: "测试用最小扩展",
			version: "1.0",
		},
	};
}
