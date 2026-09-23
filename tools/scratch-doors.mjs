// scratch (deleted before commit): why secondary doors are refused
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

const { SRC, require } = installShims({ seed: 1 });
const I = require(join(SRC, "shared/game/interiors.ts"));
const real = I.planBuilding;
const log = [];
// wrap canOpen through a proxy module: patch world's use by re-requiring world after patching exports
const W = require(join(SRC, "shared/game/world.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const type = Number(process.argv[2] ?? 3);
I.planBuilding = inp => {
	const orig = inp.canOpen;
	return real({
		...inp,
		canOpen: a => {
			const ok = orig(a);
			if (inp.type === type) log.push({ type: inp.type, a, ok });
			return ok;
		},
	});
};
const w = W.generateTown(DESIGN.TOWN_SEED);
for (const l of log) console.log(l.type, JSON.stringify(l.a), l.ok);
for (const l of log.filter(q => !q.ok)) {
	const a = l.a;
	const hit = W.querySolids(w, a.x, a.y, a.x + a.w, a.y + a.h).map(s => `${s.kind}/${s.tags}`);
	const road = w.roads.some(r => a.x < r.x + r.w && a.x + a.w > r.x && a.y < r.y + r.h && a.y + a.h > r.y);
	console.log("refused", JSON.stringify(a), "solids now:", hit.join(","), "road:", road);
}
