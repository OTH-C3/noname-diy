import { lib, game, ui, get, ai, _status } from "../../noname.js";
import { packs } from "./character/character.js";

export const type = "extension";

export default function () {
	return {
		// [警告] 文件夹名必须与这里一致，否则引擎加载不到
		name: "__扩展名__",
		// 联机可用；为 false 时联机模式下整个扩展不会被加载
		connect: true,
		content(config, pack) {},
		config: {},
		help: {},

		package: {
			...packs,
			author: "__作者__",
			intro: "__简介__",
			version: "1.0",
		},
	};
}