// scratch (deleted before commit): ASCII floor plans of planned buildings
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

const { SRC, require } = installShims({ seed: 1 });
const I = require(join(SRC, "shared/game/interiors.ts"));

const CH = 24;
const FURN = {
	sofa: "s", armchair: "a", tv: "t", bookcase: "k", counter: "c", stove: "o", fridge: "f", table: "T", bed: "B",
	nightstand: "n", wardrobe: "w", desk: "d", cabinet: "x", toilet: "u", basin: "b", tub: "U", shelf: "S", gondola: "G",
	checkout: "C", coldcase: "F", rack: "R", gunrack: "g", display: "D", clothesrack: "r", hospbed: "H", optable: "O",
	reception: "E", lockers: "L", schooldesk: "e", teacherdesk: "M", prep: "P", booth: "Y", safe: "$", bench: "=",
};

export function ascii(plan, rect) {
	const cols = Math.ceil(rect.w / CH);
	const rows = Math.ceil(rect.h / CH);
	const g = [];
	for (let j = 0; j < rows; j++) g.push(new Array(cols).fill(" "));
	const fill = (r, ch) => {
		for (let j = Math.floor((r.y - rect.y) / CH); j < Math.ceil((r.y + r.h - rect.y) / CH); j++) {
			for (let i = Math.floor((r.x - rect.x) / CH); i < Math.ceil((r.x + r.w - rect.x) / CH); i++) {
				if (j >= 0 && j < rows && i >= 0 && i < cols) g[j][i] = ch;
			}
		}
	};
	for (const p of plan.parts) fill(p, ".");
	for (const w of plan.walls) fill(w, "#");
	for (const o of plan.openings) fill(o, o.kind === "window" ? "~" : o.kind === "door" ? (o.main ? "@" : "D") : ".");
	for (const p of plan.furniture) fill(p, FURN[p.kind] ?? "?");
	for (const s of plan.loot) fill({ x: s.x - 4, y: s.y - 4, w: 8, h: 8 }, "*");
	return g.map(r => r.join("")).join("\n");
}

if (process.argv[1].endsWith("scratch-ascii.mjs")) {
	const type = Number(process.argv[2] ?? 1);
	const w = Number(process.argv[3] ?? 684);
	const h = Number(process.argv[4] ?? 556);
	const side = process.argv[5] ?? "top";
	const seed = Number(process.argv[6] ?? 12345);
	const rect = { x: 0, y: 0, w, h };
	const plan = I.planBuilding({ type, rect, side, seed, canOpen: () => true });
	console.log(ascii(plan, rect));
	console.log(plan.rooms.map(r => `${r.kind}(${r.w}x${r.h})`).join(" "));
	console.log(plan.furniture.map(p => p.kind).join(" "));
}
