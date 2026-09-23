// scratch (deleted before commit): ASCII plans of the town's buildings of one type
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";
import { ascii } from "./scratch-ascii.mjs";

const { SRC, require } = installShims({ seed: 1 });
const W = require(join(SRC, "shared/game/world.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const type = Number(process.argv[2] ?? 9);
const max = Number(process.argv[3] ?? 3);
const w = W.generateTown(Number(process.argv[4] ?? DESIGN.TOWN_SEED));
let n = 0;
for (const b of w.solids) {
	if (b.kind !== "building" || b.buildingType !== type || n >= max) continue;
	n++;
	const walls = w.solids.filter(s => s.parentId === b.id && s.tags === "bwall");
	const furniture = w.solids.filter(s => s.parentId === b.id && s.kind === "furniture");
	const plan = {
		parts: b.parts,
		walls,
		openings: b.openings,
		furniture: furniture.map(s => ({ ...s, kind: s.tags })),
		loot: b.lootSpots,
	};
	console.log(`#${b.id} ${b.tags} ${b.w}x${b.h} door ${b.doorSide} at ${Math.round(b.doorX)},${Math.round(b.doorY)}`);
	console.log(ascii(plan, b));
}
