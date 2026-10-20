import { lib, game, ui, get, ai, _status } from "../../noname.js";
import { packs } from "./character/character.js";

export const type = "extension";

export default function () {
	return {
		name: "testbad",
		package: { ...packs },
	};
}
