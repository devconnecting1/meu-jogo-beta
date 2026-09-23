// scratch (deleted before commit): what blocks a secondary door's way out
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

const { SRC, require } = installShims({ seed: 1 });
const W = require(join(SRC, "shared/game/world.ts"));
const P = require(join(SRC, "shared/game/physics.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const w = W.generateTown(Number(process.argv[3] ?? DESIGN.TOWN_SEED));
const id = Number(process.argv[2] ?? 554);
const b = w.solids.find(s => s.id === id);
const N = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
console.log("building", b.id, b.x, b.y, b.w, b.h, "parts", JSON.stringify(b.parts));
for (const o of b.openings.filter(q => q.kind === "door")) {
	const n = N[o.side];
	const ox = o.x + o.w / 2;
	const oy = o.y + o.h / 2;
	for (let t = 30; t <= 120; t += 6) {
		const hit = P.circleBlocked(w, ox + n[0] * t, oy + n[1] * t, 18);
		if (hit) {
			console.log("door", JSON.stringify(o), "t", t, "hit", hit.id, hit.kind, hit.tags, "parent", hit.parentId, JSON.stringify({ x: hit.x, y: hit.y, w: hit.w, h: hit.h }));
			break;
		}
	}
}
