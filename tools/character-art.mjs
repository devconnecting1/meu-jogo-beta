/*
 * The characters' pixel art: survivors (each outfit, walking and downed), their arms and weapons, zombies (each
 * type) and pets, rasterised from tools/character-model.mjs into the sprite sheets laid out by
 * src/client/view/charSheets.ts. Called by tools/gen-world-art.mjs, so the sheets go through the town's pipeline:
 * design/world-art/*.png, the manifest, `npm run cloud -- upload-art`, worldArtAssets.ts.
 *
 * Art direction (docs/DESIGN_RULES.md ART-07..ART-10), the town's rules applied to bodies:
 *   - 4 world units per texel (the survivor is 9 texels across the shoulders), nearest-neighbour, no anti-aliasing;
 *   - every heading pre-drawn (CHAR_DIRS columns), so a sprite is never rotated on screen: its texels stay square
 *     with the town's and the light stays where the town's is, the top left of the screen (ART-02);
 *   - a one-texel near-black outline round the silhouette (LEG-03), a one-texel shadow cast down-right by whatever
 *     stands higher (a head on the shoulders, a pack on the back);
 *   - three-step ramps per part (charRamp: cool shadows, warm lights) lit as domes and pillows; no random noise.
 *
 *   import { characterArt } from "./character-art.mjs";
 *   for (const t of characterArt(Tex)) textures.push(t);   // { name, kind, tex, description }
 *
 * Nothing random: every texel is a function of the model, the pose and the heading, so a rerun writes the same
 * bytes and the upload only sends what changed (by sha1).
 */
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";
import * as M from "./character-model.mjs";

export const TEXEL = 4;
/** the light: from the top left of the screen and above it */
const L = (() => {
	const v = [-0.52, -0.6, 0.62];
	const n = Math.hypot(...v);
	return v.map(x => x / n);
})();
/** ramp thresholds on n·L: above LIGHT a texel is lit, below SHADE it is in shadow */
const LIGHT = 0.9;
const SHADE = 0.3;
/** sub-samples per texel side for coverage */
const SUB = 4;

let sheets;
/** src/client/view/charSheets.ts through the Luau shims: the layout the client reads the sheets with */
export function loadSheets() {
	if (sheets === undefined) {
		const { SRC, require } = installShims();
		sheets = require(join(SRC, "client/view/charSheets.ts"));
	}
	return sheets;
}

/** a part with its transform precomputed (the rasteriser asks `inside` millions of times per sheet) */
function prepare(p, id) {
	const hw = p.w / 2;
	const hh = p.h / 2;
	return {
		...p,
		id,
		c: Math.cos(p.tilt),
		s: Math.sin(p.tilt),
		hw,
		hh,
		r: Math.min(p.round, hw, hh),
		reach2: (Math.hypot(hw, hh) + 0.01) ** 2,
	};
}

/** part-frame coordinates of a body-frame point, over the half sizes: (u along the part, v across) */
function local(p, f, l) {
	const dx = f - p.f;
	const dy = l - p.l;
	return [(dx * p.c + dy * p.s) / p.hw, (-dx * p.s + dy * p.c) / p.hh];
}

function inside(p, f, l) {
	const dx = f - p.f;
	const dy = l - p.l;
	if (dx * dx + dy * dy > p.reach2) return false;
	const u = dx * p.c + dy * p.s;
	const v = -dx * p.s + dy * p.c;
	if (p.shape === "oval") return (u / p.hw) ** 2 + (v / p.hh) ** 2 <= 1;
	const qx = Math.abs(u) - (p.hw - p.r);
	const qy = Math.abs(v) - (p.hh - p.r);
	if (qx <= 0 && qy <= 0) return true;
	return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - p.r <= 0;
}

/** the part's surface normal at a body-frame point, turned onto the screen: [x, y, z] */
function normalAt(p, f, l, heading) {
	let [nu, nv] = local(p, f, l);
	let nx;
	let ny;
	if (p.flat) {
		nx = 0;
		ny = 0;
	} else if (p.shape === "oval") {
		const r = Math.hypot(nu, nv);
		if (r > 0.98) {
			nu *= 0.98 / r;
			nv *= 0.98 / r;
		}
		nx = nu * p.dome;
		ny = nv * p.dome;
	} else {
		// a pillow: flat on top, rounding off over the outer part of each side
		const hw = p.hw;
		const hh = p.hh;
		const edge = (t, half) => {
			const band = Math.min(half, Math.max(p.round, 3.5)) / half;
			const a = Math.min(1, Math.abs(t));
			return Math.sign(t) * Math.max(0, (a - (1 - band)) / band) ** 1.2 * 0.95;
		};
		nx = edge(nu, hw) * p.dome;
		ny = edge(nv, hh) * p.dome;
	}
	const r2 = Math.min(0.999, nx * nx + ny * ny);
	const nz = Math.sqrt(1 - r2);
	const phi = heading + p.tilt;
	const c = Math.cos(phi);
	const s = Math.sin(phi);
	return [nx * c - ny * s, nx * s + ny * c, nz];
}

const STEP_KEYS = ["deep", "dark", "base", "light"];

/**
 * One cell: `parts` at screen heading `heading`, `cell` texels square, the body's centre on the cell's centre.
 * Returns the colour (RGBA bytes as floats) and the mask (0 empty, 1 body, 2 outline).
 */
export function rasterCell(parts, heading, cell, opts = {}) {
	const list = parts
		.map((p, i) => prepare(p, i))
		.sort((a, b) => a.layer - b.layer || a.id - b.id);
	const n = cell * cell;
	const owner = new Int16Array(n).fill(-1);
	const cosH = Math.cos(heading);
	const sinH = Math.sin(heading);
	const bodyAt = (x, y) => {
		const wx = (x - cell / 2) * TEXEL;
		const wy = (y - cell / 2) * TEXEL;
		return [wx * cosH + wy * sinH, -wx * sinH + wy * cosH];
	};
	// the whole character's reach: texels farther than this from the centre are empty
	let reach = 0;
	for (const p of list) reach = Math.max(reach, Math.hypot(p.f, p.l) + Math.sqrt(p.reach2));
	const cov = new Float32Array(list.length);
	const k1 = list.length - 1;
	for (let j = 0; j < cell; j++) {
		for (let i = 0; i < cell; i++) {
			const [cf, cl] = bodyAt(i + 0.5, j + 0.5);
			if (Math.hypot(cf, cl) > reach + TEXEL) continue;
			cov.fill(0);
			let union = 0;
			let thin = 0;
			for (let sv = 0; sv < SUB; sv++) {
				for (let su = 0; su < SUB; su++) {
					const [f, l] = bodyAt(i + (su + 0.5) / SUB, j + (sv + 0.5) / SUB);
					for (let k = k1; k >= 0; k--) {
						if (inside(list[k], f, l)) {
							cov[k] += 1 / (SUB * SUB);
							union += 1 / (SUB * SUB);
							if (list[k].thin) thin += 1 / (SUB * SUB);
							break;
						}
					}
				}
			}
			if (union < 0.45 && !(thin >= 0.28 && union >= 0.28)) continue;
			// a small mark wins the texel it covers by a quarter; otherwise the part covering most of it
			let pick = -1;
			for (let k = list.length - 1; k >= 0; k--) {
				if (list[k].detail && cov[k] >= 0.25) {
					pick = k;
					break;
				}
			}
			if (pick < 0) {
				let best = 0;
				for (let k = list.length - 1; k >= 0; k--) {
					if (cov[k] > best + 1e-6) {
						best = cov[k];
						pick = k;
					}
				}
			}
			owner[j * cell + i] = pick;
		}
	}
	const at = (x, y) => (x < 0 || y < 0 || x >= cell || y >= cell ? -1 : owner[y * cell + x]);
	const out = new Float32Array(n * 4);
	const mask = new Uint8Array(n);
	for (let j = 0; j < cell; j++) {
		for (let i = 0; i < cell; i++) {
			const k = at(i, j);
			if (k < 0) continue;
			const p = list[k];
			const [f, l] = bodyAt(i + 0.5, j + 0.5);
			let s;
			if (p.glow) {
				const [nu, nv] = local(p, f, l);
				const r2 = nu * nu + nv * nv;
				s = r2 < 0.35 ? 3 : r2 < 0.8 ? 2 : 1;
			} else {
				const nrm = normalAt(p, f, l, heading);
				const lam = nrm[0] * L[0] + nrm[1] * L[1] + nrm[2] * L[2];
				s = lam > LIGHT ? 3 : lam > SHADE ? 2 : 1;
				if (p.flat) s = 2;
			}
			// something standing higher just up-left of this texel casts its shadow on it
			const q = at(i - 1, j - 1);
			if (q >= 0 && q !== k && list[q].layer > p.layer && list[q].lift && !p.glow) s = Math.max(0, s - 1);
			const c = p.ramp[STEP_KEYS[s]];
			const o = (j * cell + i) * 4;
			out[o] = c[0];
			out[o + 1] = c[1];
			out[o + 2] = c[2];
			out[o + 3] = 255;
			mask[j * cell + i] = 1;
		}
	}
	// the outline: every empty texel beside the body, near-black with a breath of the part it rings
	const ink = opts.ink ?? M.INK;
	for (let j = 0; j < cell; j++) {
		for (let i = 0; i < cell; i++) {
			if (at(i, j) >= 0) continue;
			let nb = -1;
			for (const [dx, dy] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			]) {
				const q = at(i + dx, j + dy);
				if (q >= 0) nb = q;
			}
			if (nb < 0) continue;
			const deep = list[nb].ramp.deep;
			const o = (j * cell + i) * 4;
			for (let c = 0; c < 3; c++) out[o + c] = deep[c] * 0.2 + ink[c] * 0.8;
			out[o + 3] = 255;
			mask[j * cell + i] = 2;
		}
	}
	return { rgba: out, mask, cell };
}

// ---------------------------------------------------------------- the sheets

/** what each melee weapon looks like (the rows' length comes from its reach: MELEE_REACH) */
const MELEE_VISUAL = {
	0: "dagger",
	1: "club",
	2: "axe",
	3: "crowbar",
	4: "saw",
	5: "chainsaw",
	6: "bat",
	7: "blade",
	8: "golf",
	11: "blade",
	27: "stoneAxe",
	28: "goldAxe",
	29: "goldBlade",
};
/** the gun rows, in charSheets.GUN_ROW_IDS order */
const GUN_VISUAL = ["pistol", "rifle", "shotgun", "mg", "sniper", "bow", "crossbow", "flamer", "stun"];

/**
 * Every row of every sheet, as the parts to rasterise and the ink of its outline:
 * { name, cell, rows: [{ parts, ink? }], maskRows? }. The order of rows is charSheets.ts's.
 */
export function sheetSpecs() {
	const S = loadSheets();
	const { SRC, require } = installShims();
	const W = require(join(SRC, "shared/data/weapons.ts"));
	const steps = [];
	for (let r = 0; r < S.STEPS; r++) steps.push(S.rowStep(r));

	const zombies = [];
	for (let k = 1; k <= 5; k++) for (const s of steps) zombies.push({ parts: M.zombieParts(k, s) });
	zombies.push({ parts: M.zombieParts(2, 0, 0.5) }, { parts: M.zombieParts(2, 0, 1) });
	zombies.push({ parts: M.zombieParts(5, 0, 0, true) });
	for (const s of steps) zombies.push({ parts: M.zombieParts(4, s, 0, false, true) });

	const survivors = [];
	for (let o = 0; o < S.OUTFITS; o++) for (const s of steps) survivors.push({ parts: M.survivorParts(o, s) });
	for (let o = 0; o < S.OUTFITS; o++) {
		for (const d of [-1, 0, 1]) survivors.push({ parts: M.downedParts(o, d), ink: M.INK_DOWNED });
	}

	const arms = [];
	for (let o = 0; o < S.OUTFITS; o++) for (const len of S.ARM_LENGTHS) arms.push({ parts: M.armParts(o, len) });

	const weapons = [];
	for (const id of S.MELEE_IDS) {
		const reach = W.MELEE_REACH[id] ?? 70;
		const visual = MELEE_VISUAL[id] ?? "blade";
		weapons.push({ parts: M.weaponParts(visual, S.meleeSwingLength(reach)) });
		weapons.push({ parts: M.weaponParts(visual, S.meleeIdleLength(reach)) });
	}
	S.GUN_ROW_IDS.forEach((id, g) => {
		const w = W.WEAPONS[id];
		weapons.push({ parts: M.weaponParts(GUN_VISUAL[g], S.gunLength(w.kind)) });
	});

	const dogs = [];
	for (const pet of [4, 5, 6]) {
		for (const s of steps) dogs.push({ parts: M.dogParts(pet, s, 0) });
		for (const wag of [-1, 0, 1]) dogs.push({ parts: M.dogParts(pet, 0, wag) });
	}
	const birds = [];
	for (const pet of [1, 2, 3]) {
		for (const spread of pet === 3 ? S.EAGLE_SPREADS : S.PIGEON_SPREADS) birds.push({ parts: M.birdParts(pet, spread) });
	}

	const check = (name, rows, want) => {
		if (rows.length !== want) throw new Error(`${name}: ${rows.length} rows, charSheets.ts says ${want}`);
	};
	check("zombies", zombies, S.ZOMBIE_ROWS);
	check("survivors", survivors, S.SURVIVOR_ROWS);
	check("arms", arms, S.ARM_ROWS);
	check("weapons", weapons, S.WEAPON_ROWS);
	check("dogs", dogs, S.DOG_ROWS);
	check("birds", birds, S.BIRD_ROWS);
	return [
		{ name: "zombies", cell: S.ZOMBIE_CELL, rows: zombies, masks: S.ZOMBIE_ROWS },
		{ name: "survivors", cell: S.SURVIVOR_CELL, rows: survivors, masks: S.SURVIVOR_MASK_ROWS },
		{ name: "arms", cell: S.ARM_CELL, rows: arms },
		{ name: "weapons", cell: S.WEAPON_CELL, rows: weapons },
		{ name: "dogs", cell: S.DOG_CELL, rows: dogs },
		{ name: "birds", cell: S.BIRD_CELL, rows: birds },
	];
}

const DESCRIPTIONS = {
	zombies: "zombies: walker, spitter, exploder, charger, jumper x 5 strides; spitter wind-ups, jumper in the air, charger charging (ART-09)",
	zombiesFill: "zombies: white silhouettes of the same cells (tint: hit flash, lit fuse)",
	zombiesRim: "zombies: white outlines of the same cells (tint: the hit outline, the lit fuse's yellow)",
	survivors: "survivors: 4 outfits x 5 strides, then the downed crawl (ART-08)",
	survivorsFill: "survivors: white silhouettes of the walking cells (tint: hit flash, poison)",
	survivorsRim: "survivors: white outlines of the walking cells (tint: the red hit outline, LEG-02)",
	arms: "survivors' arms, shoulder to hand, per outfit x 9 lengths (placed on the weapon's grip)",
	weapons: "weapons in hand: each melee weapon swung and held, then the guns and bows",
	dogs: "pets: Carolina, Malamute, Doberman x 5 trot strides + 3 tail wags (ART-10)",
	birds: "pets: Pigeon, White pigeon, Eagle x landed + 4 wing spreads (ART-10)",
};

/**
 * Every character texture, in manifest order: { name, kind, tex, description }. `Tex` is tools/gen-world-art.mjs's
 * texel canvas. Every cell is checked to keep a one-texel empty margin (a sampler never bleeds into a neighbour).
 */
export function characterArt(Tex) {
	const S = loadSheets();
	const out = [];
	for (const spec of sheetSpecs()) {
		const cols = S.CHAR_DIRS;
		const cell = spec.cell;
		const color = new Tex(cols * cell, spec.rows.length * cell);
		const fill = spec.masks !== undefined ? new Tex(cols * cell, spec.masks * cell) : undefined;
		const rim = spec.masks !== undefined ? new Tex(cols * cell, spec.masks * cell) : undefined;
		spec.rows.forEach((row, ri) => {
			for (let col = 0; col < cols; col++) {
				const r = rasterCell(row.parts, S.dirHeading(col), cell, row.ink !== undefined ? { ink: row.ink } : {});
				const b = cellBounds(r);
				if (b.x0 < 1 || b.y0 < 1 || b.x1 > cell - 2 || b.y1 > cell - 2) {
					throw new Error(`${spec.name} row ${ri} col ${col}: touches the cell's margin (${JSON.stringify(b)})`);
				}
				for (let j = 0; j < cell; j++) {
					for (let i = 0; i < cell; i++) {
						const m = r.mask[j * cell + i];
						if (m === 0) continue;
						const o = (j * cell + i) * 4;
						const x = col * cell + i;
						const y = ri * cell + j;
						color.set(x, y, [r.rgba[o], r.rgba[o + 1], r.rgba[o + 2]], 255);
						if (fill !== undefined && ri < spec.masks) {
							if (m === 1) fill.set(x, y, [255, 255, 255], 255);
							else rim.set(x, y, [255, 255, 255], 255);
						}
					}
				}
			}
		});
		out.push({ name: spec.name, kind: "sheet", tex: color, description: DESCRIPTIONS[spec.name] });
		if (fill !== undefined) {
			out.push({ name: `${spec.name}Fill`, kind: "mask", tex: fill, description: DESCRIPTIONS[`${spec.name}Fill`] });
			out.push({ name: `${spec.name}Rim`, kind: "mask", tex: rim, description: DESCRIPTIONS[`${spec.name}Rim`] });
		}
	}
	// keep the manifest's order stable and readable: survivors first, the horde, then the pets
	const order = ["survivors", "survivorsFill", "survivorsRim", "arms", "weapons", "zombies", "zombiesFill", "zombiesRim", "dogs", "birds"];
	out.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
	return out;
}

/** a cell's bounding box of non-empty texels (tests: nothing may touch the cell's border) */
export function cellBounds(r) {
	let x0 = r.cell;
	let y0 = r.cell;
	let x1 = -1;
	let y1 = -1;
	for (let j = 0; j < r.cell; j++) {
		for (let i = 0; i < r.cell; i++) {
			if (r.mask[j * r.cell + i] === 0) continue;
			x0 = Math.min(x0, i);
			y0 = Math.min(y0, j);
			x1 = Math.max(x1, i);
			y1 = Math.max(y1, j);
		}
	}
	return { x0, y0, x1, y1 };
}
