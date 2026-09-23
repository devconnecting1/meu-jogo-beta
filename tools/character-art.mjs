/*
 * The characters' pixel art: survivors (each outfit, each grip, walking, swinging and downed, arms baked in), the
 * weapons in their hands, zombies (each type) and pets, rasterised from tools/character-model.mjs into the sprite
 * sheets laid out by src/client/view/charSheets.ts. Called by tools/gen-world-art.mjs, so the sheets go through the
 * town's pipeline: design/world-art/*.png, the manifest, `npm run cloud -- upload-art`, worldArtAssets.ts.
 *
 * Art direction (docs/DESIGN_RULES.md ART-08..ART-11), the town's rules applied to bodies:
 *   - 4 world units per texel (the survivor is 9 texels across the shoulders), nearest-neighbour, no anti-aliasing;
 *   - every heading pre-drawn (CHAR_DIRS columns), so a sprite is never rotated on screen: its texels stay square
 *     with the town's and the light stays where the town's is, the top left of the screen (ART-02);
 *   - a one-texel near-black outline round the silhouette (LEG-03) -- only on the shadow side for the weapons, so a
 *     blade stays one texel of steel --, a dark line round a head or a hat where it lies over the body (`ring`, the
 *     selective outline), a one-texel shadow cast down-right by whatever stands higher (a head on the shoulders,
 *     a pack on the back);
 *   - three- and four-step ramps per part (charRamp: cool shadows, warm lights) lit as domes and pillows; a clean-up
 *     pass that fixes what tracing leaves on a small grid (specks, notches, spurs); no random noise.
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
/** the neighbours a raised part casts its shadow from (up-left, up, left of the texel it darkens) */
const CASTERS = [
	[-1, -1],
	[0, -1],
	[-1, 0],
];
/** where an outline texel looks for the body: all round, or only up and left (a drop outline) */
const RING = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
];
const DROP = [
	[-1, 0],
	[0, -1],
	[-1, -1],
];

/**
 * What a pixel artist fixes by hand after tracing a shape onto the grid, so every heading reads as drawn, not
 * sampled: a lone texel of one part inside another (a speck) takes its surroundings' part, a notch one texel deep
 * in the silhouette is filled, and a one-texel spur sticking out of it is shaved -- except the marks meant to be
 * that small (`detail`), the limbs (`thin`) and anything under two texels across, whose diagonal steps ARE their
 * shape.
 */
function cleanUp(owner, cell, list, at) {
	const counts = new Map();
	const majority = (i, j) => {
		counts.clear();
		let best = -1;
		let bestN = 0;
		for (const [dx, dy] of RING) {
			const q = at(i + dx, j + dy);
			if (q < 0) continue;
			const c = (counts.get(q) ?? 0) + 1;
			counts.set(q, c);
			if (c > bestN) {
				bestN = c;
				best = q;
			}
		}
		return [best, bestN];
	};
	const next = Int16Array.from(owner);
	for (let j = 0; j < cell; j++) {
		for (let i = 0; i < cell; i++) {
			const k = at(i, j);
			const [best, bestN] = majority(i, j);
			if (k < 0) {
				// a notch: empty with three or four neighbours in the body
				let filled = 0;
				for (const [dx, dy] of RING) if (at(i + dx, j + dy) >= 0) filled++;
				if (filled >= 3 && best >= 0 && !list[best].detail) next[j * cell + i] = best;
				continue;
			}
			const p = list[k];
			// a limb, a mark, or anything under two texels across (a blade seen at 45 degrees is a staircase of
			// single texels: each one is a "spur", and shaving them would erase the blade)
			if (p.detail || p.thin || Math.min(p.w, p.h) < 2 * TEXEL) continue;
			let filled = 0;
			for (const [dx, dy] of RING) if (at(i + dx, j + dy) >= 0) filled++;
			if (filled <= 1) {
				// a spur of the silhouette
				next[j * cell + i] = -1;
				continue;
			}
			// a speck: every neighbour in the body belongs to one other part
			if (best >= 0 && best !== k && bestN === filled && bestN >= 3) next[j * cell + i] = best;
		}
	}
	owner.set(next);
}

/**
 * One cell: `parts` at screen heading `heading`, `cell` texels square, the body's centre on the cell's centre.
 * Returns the colour (RGBA bytes as floats) and the mask (0 empty, 1 body, 2 outline).
 */
export function rasterCell(parts, heading, cell, opts = {}) {
	const list = parts.map((p, i) => prepare(p, i)).sort((a, b) => a.layer - b.layer || a.id - b.id);
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
			// a small mark wins the texel it covers by a third; otherwise the part covering most of it
			let pick = -1;
			for (let k = list.length - 1; k >= 0; k--) {
				if (list[k].detail && cov[k] >= 0.34) {
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
	cleanUp(owner, cell, list, at);
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
			// something standing higher just up, left or up-left of this texel casts its shadow on it (the light
			// is at the top left): a head on the shoulders, a pack on the back, a hand on a sleeve
			if (!p.glow) {
				for (const [dx, dy] of CASTERS) {
					const q = at(i + dx, j + dy);
					if (q >= 0 && q !== k && list[q].layer > p.layer && list[q].lift) {
						s = Math.max(0, s - 1);
						break;
					}
				}
			}
			const c = p.ramp[STEP_KEYS[s]];
			const o = (j * cell + i) * 4;
			out[o] = c[0];
			out[o + 1] = c[1];
			out[o + 2] = c[2];
			out[o + 3] = 255;
			mask[j * cell + i] = 1;
		}
	}
	// the inner line: a part marked `ring` (a head, a hat) is also outlined where it lies over the body, in a dark
	// of what it lies on -- the pixel artist's selective outline, what makes a 4-texel head read on the shoulders
	const inner = opts.ink ?? M.INK;
	for (let j = 0; j < cell; j++) {
		for (let i = 0; i < cell; i++) {
			const k = at(i, j);
			if (k < 0) continue;
			const p = list[k];
			if (p.ring) continue;
			let ringed = false;
			for (const [dx, dy] of RING) {
				const q = at(i + dx, j + dy);
				if (q >= 0 && list[q].ring && list[q].layer > p.layer) ringed = true;
			}
			if (!ringed) continue;
			const deep = p.ramp.deep;
			const o = (j * cell + i) * 4;
			for (let c = 0; c < 3; c++) out[o + c] = deep[c] * 0.45 + inner[c] * 0.55;
		}
	}
	// the outline: every empty texel beside the body, near-black with a breath of the part it rings. A "drop"
	// outline (the weapons) only rings the shadow side, below and right: a blade stays one texel of steel with
	// its dark edge, instead of three texels of ink with steel in the middle
	const ink = opts.ink ?? M.INK;
	const around = opts.outline === "drop" ? DROP : RING;
	for (let j = 0; j < cell; j++) {
		for (let i = 0; i < cell; i++) {
			if (at(i, j) >= 0) continue;
			let nb = -1;
			for (const [dx, dy] of around) {
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
 * { name, cell, rows: [{ parts, ink? }], masks?: boolean, outline? }. The order of rows is charSheets.ts's.
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

	// two outfits per sheet (survivorsA: plain, Santa; survivorsB: Zombie, Cowboy)
	const survivorSheets = [];
	for (let sheet = 0; sheet < S.SURVIVOR_SHEETS; sheet++) {
		const rows = [];
		for (let k = 0; k < S.OUTFITS_PER_SHEET; k++) {
			const o = sheet * S.OUTFITS_PER_SHEET + k;
			for (let g = 0; g < S.GRIPS; g++) {
				for (const s of steps) rows.push({ parts: M.survivorParts(o, S.GRIP_HANDS[g], s) });
			}
			for (const rel of S.SWINGS) {
				const hands = [S.SWING_HAND * Math.cos(rel), S.SWING_HAND * Math.sin(rel), 10, -14];
				rows.push({ parts: M.survivorParts(o, hands, 0) });
			}
			for (const d of [-1, 0, 1]) rows.push({ parts: M.downedParts(o, d), ink: M.INK_DOWNED });
		}
		survivorSheets.push(rows);
	}

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
		for (const spread of pet === 3 ? S.EAGLE_SPREADS : S.PIGEON_SPREADS)
			birds.push({ parts: M.birdParts(pet, spread) });
	}

	const check = (name, rows, want) => {
		if (rows.length !== want) throw new Error(`${name}: ${rows.length} rows, charSheets.ts says ${want}`);
	};
	check("zombies", zombies, S.ZOMBIE_ROWS);
	survivorSheets.forEach((rows, i) => check(`survivors ${i}`, rows, S.SURVIVOR_ROWS));
	check("weapons", weapons, S.WEAPON_ROWS);
	check("dogs", dogs, S.DOG_ROWS);
	check("birds", birds, S.BIRD_ROWS);
	return [
		...survivorSheets.map((rows, i) => ({
			name: `survivors${SHEET_LETTERS[i]}`,
			cell: S.SURVIVOR_CELL,
			rows,
			masks: true,
		})),
		{ name: "weapons", cell: S.WEAPON_CELL, rows: weapons, outline: "drop" },
		{ name: "zombies", cell: S.ZOMBIE_CELL, rows: zombies, masks: true },
		{ name: "dogs", cell: S.DOG_CELL, rows: dogs },
		{ name: "birds", cell: S.BIRD_CELL, rows: birds },
	];
}

/** survivor sheets are named A, B, ... (charArt.ts SURVIVOR_SHEET_NAMES) */
const SHEET_LETTERS = ["A", "B", "C", "D"];

const DESCRIPTIONS = {
	survivorsA:
		"survivors, plain and Santa: 4 grips x 3 strides, 5 swings, 3 crawls, whole body and arms in one cell (ART-09)",
	survivorsAFill: "survivorsA: white silhouettes of the same cells (tint: hit flash, poison)",
	survivorsARim: "survivorsA: white outlines of the same cells (tint: the red hit outline, LEG-02)",
	survivorsB:
		"survivors, Zombie costume and Cowboy: 4 grips x 3 strides, 5 swings, 3 crawls, whole body and arms (ART-09)",
	survivorsBFill: "survivorsB: white silhouettes of the same cells (tint: hit flash, poison)",
	survivorsBRim: "survivorsB: white outlines of the same cells (tint: the red hit outline, LEG-02)",
	weapons: "weapons in hand: each melee weapon swung and held, then the guns and bows (ART-09)",
	zombies:
		"zombies: walker, spitter, exploder, charger, jumper x 3 strides; spitter wind-ups, jumper in the air, charger charging (ART-10)",
	zombiesFill: "zombies: white silhouettes of the same cells (tint: hit flash, lit fuse)",
	zombiesRim: "zombies: white outlines of the same cells (tint: the hit outline, the lit fuse's yellow)",
	dogs: "pets: Carolina, Malamute, Doberman x 3 trot strides + 3 tail wags (ART-11)",
	birds: "pets: Pigeon, White pigeon, Eagle x landed + 4 wing spreads (ART-11)",
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
		const fill = spec.masks === true ? new Tex(cols * cell, spec.rows.length * cell) : undefined;
		const rim = spec.masks === true ? new Tex(cols * cell, spec.rows.length * cell) : undefined;
		spec.rows.forEach((row, ri) => {
			for (let col = 0; col < cols; col++) {
				const r = rasterCell(row.parts, S.dirHeading(col), cell, { ink: row.ink, outline: spec.outline });
				const b = cellBounds(r);
				if (b.x0 < 1 || b.y0 < 1 || b.x1 > cell - 2 || b.y1 > cell - 2) {
					throw new Error(
						`${spec.name} row ${ri} col ${col}: touches the cell's margin (${JSON.stringify(b)})`,
					);
				}
				for (let j = 0; j < cell; j++) {
					for (let i = 0; i < cell; i++) {
						const m = r.mask[j * cell + i];
						if (m === 0) continue;
						const o = (j * cell + i) * 4;
						const x = col * cell + i;
						const y = ri * cell + j;
						color.set(x, y, [r.rgba[o], r.rgba[o + 1], r.rgba[o + 2]], 255);
						if (fill !== undefined) {
							if (m === 1) fill.set(x, y, [255, 255, 255], 255);
							else rim.set(x, y, [255, 255, 255], 255);
						}
					}
				}
			}
		});
		out.push({ name: spec.name, kind: "sheet", tex: color, description: DESCRIPTIONS[spec.name] });
		if (fill !== undefined) {
			out.push({
				name: `${spec.name}Fill`,
				kind: "mask",
				tex: fill,
				description: DESCRIPTIONS[`${spec.name}Fill`],
			});
			out.push({ name: `${spec.name}Rim`, kind: "mask", tex: rim, description: DESCRIPTIONS[`${spec.name}Rim`] });
		}
	}
	// the manifest's order: survivors first, their weapons, the horde, then the pets (as sheetSpecs lists them)
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
