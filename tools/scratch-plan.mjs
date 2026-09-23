// scratch: generate the town and print interior stats (deleted before commit)
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

const { SRC, require } = installShims({ seed: 1 });
const W = require(join(SRC, "shared/game/world.ts"));
const { DESIGN } = require(join(SRC, "shared/engine/constants.ts"));
const seed = Number(process.argv[2] ?? DESIGN.TOWN_SEED);
const t0 = performance.now();
const w = W.generateTown(seed);
console.log(`gen ${Math.round(performance.now() - t0)} ms, ${w.solids.length} solids`);
const byType = {};
for (const b of w.solids.filter(s => s.kind === "building")) {
	const k = `${b.buildingType}:${b.tags}`;
	const o = (byType[k] ??= { n: 0, parts: 0, rect: 0, doors: 0, win: 0, inner: 0, walls: 0, furn: 0, loot: 0, noMain: 0 });
	o.n++;
	o.parts += b.parts.length;
	if (b.parts.length === 1) o.rect++;
	o.doors += b.openings.filter(p => p.kind === "door").length;
	o.win += b.openings.filter(p => p.kind === "window").length;
	o.inner += b.openings.filter(p => p.kind === "inner").length;
	if (!b.openings.some(p => p.main)) o.noMain++;
	o.loot += b.lootSpots.length;
}
for (const s of w.solids) {
	if (s.parentId === undefined) continue;
	const b = w.solids.find(q => q.id === s.parentId);
	const o = byType[`${b.buildingType}:${b.tags}`];
	if (s.tags === "bwall") o.walls++;
	if (s.kind === "furniture") o.furn++;
}
for (const [k, o] of Object.entries(byType)) {
	const f = v => (v / o.n).toFixed(1);
	console.log(
		`${k.padEnd(14)} n=${String(o.n).padStart(3)} rect=${o.rect} noMain=${o.noMain} parts ${f(o.parts)} doors ${f(o.doors)} win ${f(o.win)} inner ${f(o.inner)} walls ${f(o.walls)} furn ${f(o.furn)} loot ${f(o.loot)}`,
	);
}
