/*
 * The characters' pixel art: the survivors (each outfit), the zombies (each type), the dogs and the birds, rasterised
 * from the ONE model the flat drawing uses (src/client/view/charModel.ts, loaded here through tools/luau-shim.mjs)
 * into sprite sheets laid out by src/client/view/charSheets.ts. Called by tools/gen-world-art.mjs, so the sheets go
 * through the town's pipeline: design/world-art/*.png, the manifest, `npm run cloud -- upload-art`, worldArtAssets.ts.
 *
 * Art direction (docs/DESIGN_RULES.md ART-07..ART-10), the town's rules applied to bodies:
 *   - 4 world units per texel (the survivor is ~9 texels across the shoulders), nearest-neighbour, no anti-aliasing;
 *   - every heading pre-drawn (32 columns), so a sprite is never rotated on screen and its texels stay square with
 *     the town's; the light is baked per heading from the top LEFT OF THE SCREEN, the town's convention (ART-02);
 *   - a one-texel near-black outline round the silhouette (LEG-03), a dark contact line where a part lies on another
 *     (a head on the shoulders, a pack on the back), and a one-texel cast shadow down-right of what stands higher;
 *   - 3-4 step ramps per material (charModel.rampOf): shadows cool, lights warm; grime on cloth, rot on infected
 *     skin, strands of hair, dried blood that is irregular and unlit, glowing acid and boils; torn cloth with ragged
 *     edges and holes. Noise is sampled in the BODY's frame, so a stain stays on the shoulder as the body turns.
 *
 *   import { characterArt } from "./character-art.mjs";
 *   for (const t of characterArt(Tex)) textures.push(t);   // { name, kind, tex, description }
 *
 * Nothing random: every texel is a function of the model, the pose and a hash, so a rerun writes the same bytes
 * (the upload only sends what changed, by sha1).
 */
import { join } from "node:path";
import { installShims } from "./luau-shim.mjs";

const TEXEL = 4;
/** the light, from the top left of the screen and above it */
const L = (() => {
	const v = [-0.55, -0.62, 0.72];
	const n = Math.hypot(...v);
	return v.map(x => x / n);
})();

let model;
let sheets;
function load() {
	if (model !== undefined) return;
	const { SRC, require } = installShims();
	model = require(join(SRC, "client/view/charModel.ts"));
	sheets = require(join(SRC, "client/view/charSheets.ts"));
}

const rgb = c => [c.R * 255, c.G * 255, c.B * 255];

/** a stable hash of a body-frame texel and a seed, in [0, 1) */
function hash(x, y, seed) {
	let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

/** smooth value noise in the body frame (cell = `size` world units), in [0, 1) */
function vnoise(f, l, size, seed) {
	const x = f / size;
	const y = l / size;
	const i = Math.floor(x);
	const j = Math.floor(y);
	const u = x - i;
	const v = y - j;
	const s = t => t * t * (3 - 2 * t);
	const a = hash(i, j, seed);
	const b = hash(i + 1, j, seed);
	const c = hash(i, j + 1, seed);
	const d = hash(i + 1, j + 1, seed);
	const top = a + (b - a) * s(u);
	const bot = c + (d - c) * s(u);
	return top + (bot - top) * s(v);
}

/** a copy of the list's parts, in painting order (layer, then the order they were added) */
function snapshot(list) {
	const out = [];
	for (let i = 0; i < list.n; i++) {
		const p = list.parts[i];
		out.push({ ...p, id: i, seed: 17 + i * 31 });
	}
	out.sort((a, b) => a.layer - b.layer || a.id - b.id);
	return out;
}

/** part-frame coordinates of a body-frame point: u along the part, v across, both over the half-size */
function local(p, f, l) {
	const dx = f - p.f;
	const dy = l - p.l;
	const c = Math.cos(p.tilt);
	const s = Math.sin(p.tilt);
	return [(dx * c + dy * s) / (p.w / 2), (-dx * s + dy * c) / (p.h / 2)];
}

function inside(p, f, l) {
	const M = model;
	const [nu, nv] = local(p, f, l);
	const hw = p.w / 2;
	const hh = p.h / 2;
	let d;
	if (p.shape === M.PART_OVAL) d = nu * nu + nv * nv - 1;
	else {
		const r = Math.min(p.round, hw, hh);
		const qx = Math.abs(nu * hw) - (hw - r);
		const qy = Math.abs(nv * hh) - (hh - r);
		d = (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r) / Math.max(1, Math.min(hw, hh));
	}
	if (p.mat === M.MAT_BLOOD) {
		// a splotch, not a disc: the rim eaten irregularly
		d += (vnoise(f, l, 3.2, p.seed) - 0.5) * 0.9;
	} else if (p.mat === M.MAT_RAG) {
		// torn cloth: a ragged edge and a few holes where what is under shows through
		d += (vnoise(f, l, 4.5, p.seed) - 0.5) * 0.55;
		if (d < 0 && vnoise(f, l, 3.5, p.seed + 7) < 0.14) return false;
	}
	return d <= 0;
}

/** the ramp step of a lit texel: 0 deep, 1 dark, 2 base, 3 light */
function litStep(p, f, l, heading, dither) {
	const M = model;
	const [nu, nv] = local(p, f, l);
	let nx;
	let ny;
	if (p.shape === M.PART_OVAL) {
		nx = nu;
		ny = nv;
	} else {
		// a box is a pillow: flat on top, rounding off over its outer third
		const e = t => Math.sign(t) * Math.max(0, (Math.abs(t) - 0.45) / 0.55) ** 1.4;
		nx = e(nu);
		ny = e(nv);
	}
	const r2 = Math.min(1, nx * nx + ny * ny);
	const nz = Math.sqrt(1 - r2);
	// the part's frame turned onto the screen
	const phi = heading + p.tilt;
	const c = Math.cos(phi);
	const s = Math.sin(phi);
	const sx = nx * c - ny * s;
	const sy = nx * s + ny * c;
	const lam = sx * L[0] + sy * L[1] + nz * L[2] + dither;
	if (lam > 0.9) return 3;
	if (lam > 0.42) return 2;
	return 1;
}

function stepColor(rp, step) {
	return rgb(step >= 3 ? rp.light : step === 2 ? rp.base : step === 1 ? rp.dark : rp.deep);
}

/**
 * One cell: the pose in `list` at screen heading `heading`, `cell` texels square, centred on the body.
 * Returns RGBA (0..255 floats) and the silhouette mask (1 = body, 2 = outline).
 */
function rasterCell(list, heading, cell, outlineColor) {
	const M = model;
	const parts = snapshot(list);
	const n = cell * cell;
	const owner = new Int16Array(n).fill(-1);
	const step = new Int8Array(n);
	const cosH = Math.cos(heading);
	const sinH = Math.sin(heading);
	const bodyAt = (x, y) => {
		const wx = (x - cell / 2) * TEXEL;
		const wy = (y - cell / 2) * TEXEL;
		return [wx * cosH + wy * sinH, -wx * sinH + wy * cosH];
	};
	const SUB = 4;
	const cov = new Float32Array(parts.length);
	for (let j = 0; j < cell; j++) {
		for (let i = 0; i < cell; i++) {
			cov.fill(0);
			for (let sv = 0; sv < SUB; sv++) {
				for (let su = 0; su < SUB; su++) {
					const [f, l] = bodyAt(i + (su + 0.5) / SUB, j + (sv + 0.5) / SUB);
					let top = -1;
					for (let k = 0; k < parts.length; k++) {
						if ((parts[k].flags & M.F_ART) !== 0 && inside(parts[k], f, l)) top = k;
					}
					if (top >= 0) cov[top] += 1 / (SUB * SUB);
				}
			}
			let union = 0;
			let best = -1;
			let bestCov = 0;
			let pick = -1;
			for (let k = parts.length - 1; k >= 0; k--) {
				union += cov[k];
				if (pick < 0 && cov[k] >= 0.34) pick = k;
				if (cov[k] > bestCov) {
					bestCov = cov[k];
					best = k;
				}
			}
			if (pick < 0 && union >= 0.45) pick = best;
			owner[j * cell + i] = pick;
		}
	}
	const at = (x, y) => (x < 0 || y < 0 || x >= cell || y >= cell ? -1 : owner[y * cell + x]);
	// the ramp step of every body texel: light, then materials, then the contact lines and cast shadows
	const out = new Float32Array(n * 4);
	for (let j = 0; j < cell; j++) {
		for (let i = 0; i < cell; i++) {
			const k = at(i, j);
			if (k < 0) continue;
			const p = parts[k];
			const [f, l] = bodyAt(i + 0.5, j + 0.5);
			const dither = (i + j) % 2 === 0 ? 0.035 : -0.035;
			let s = litStep(p, f, l, heading, dither);
			const bf = Math.round(f / TEXEL);
			const bl = Math.round(l / TEXEL);
			if (p.mat === M.MAT_CLOTH || p.mat === M.MAT_RAG) {
				const g = hash(bf, bl, p.seed);
				if (g < 0.1) s = Math.max(1, s - 1);
				else if (g > 0.95 && s < 3) s++;
			} else if (p.mat === M.MAT_ROT) {
				const g = vnoise(f, l, 7, p.seed);
				if (g < 0.3) s = Math.max(1, s - 1);
				else if (hash(bf, bl, p.seed) > 0.93) s = Math.max(1, s - 1);
			} else if (p.mat === M.MAT_HAIR) {
				const strand = hash(Math.round(l / 3), Math.round(f / 6), p.seed);
				if (strand < 0.35) s = Math.max(1, s - 1);
			} else if (p.mat === M.MAT_FUR) {
				const g = hash(bf, bl, p.seed);
				if (g < 0.12) s = Math.max(1, s - 1);
				else if (g > 0.93 && s < 3) s++;
			} else if (p.mat === M.MAT_BLOOD) {
				// unlit: a dried rim and a darker, wetter core
				const [nu, nv] = local(p, f, l);
				s = nu * nu + nv * nv < 0.35 ? 1 : 2;
			} else if (p.mat === M.MAT_GLOW) {
				const [nu, nv] = local(p, f, l);
				const r2 = nu * nu + nv * nv;
				s = r2 < 0.3 ? 3 : r2 < 0.75 ? 2 : 1;
			} else if (p.mat === M.MAT_METAL) {
				s = s >= 2 ? 3 : 1;
			}
			step[j * cell + i] = s;
		}
	}
	for (let j = 0; j < cell; j++) {
		for (let i = 0; i < cell; i++) {
			const k = at(i, j);
			if (k < 0) continue;
			const p = parts[k];
			let s = step[j * cell + i];
			// a part lying on this one: a dark contact line where it meets it
			let line = false;
			for (const [dx, dy] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			]) {
				const q = at(i + dx, j + dy);
				if (q < 0 || q === k) continue;
				const o = parts[q];
				if (o.layer > p.layer && (o.flags & M.F_EDGE) !== 0) line = true;
			}
			if (line) s = 0;
			else {
				// something standing higher up-left of this texel shades it (a head over the shoulders)
				const q = at(i - 1, j - 1);
				if (q >= 0 && q !== k && parts[q].layer > p.layer && (parts[q].flags & M.F_LIFT) !== 0) s = Math.max(0, s - 1);
			}
			const c = stepColor(p.ramp, s);
			const o = (j * cell + i) * 4;
			out[o] = c[0];
			out[o + 1] = c[1];
			out[o + 2] = c[2];
			out[o + 3] = 255;
		}
	}
	// the outline: every empty texel beside the body
	const mask = new Uint8Array(n);
	for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) if (at(x, y) >= 0) mask[y * cell + x] = 1;
	const ink = rgb(outlineColor ?? model.OUTLINE_INK);
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
			const deep = rgb(parts[nb].ramp.deep);
			const o = (j * cell + i) * 4;
			for (let c = 0; c < 3; c++) out[o + c] = deep[c] * 0.25 + ink[c] * 0.75;
			out[o + 3] = 255;
			mask[j * cell + i] = 2;
		}
	}
	return { rgba: out, mask };
}

/** a sheet texture: `cols` x `rows` cells of `cell` texels, painted by `paint(col, row) -> cell raster or null` */
function sheet(Tex, cell, cols, rows, paint, asMask) {
	const t = new Tex(cols * cell, rows * cell);
	let used = 0;
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const r = paint(col, row);
			if (r === undefined) continue;
			for (let j = 0; j < cell; j++) {
				for (let i = 0; i < cell; i++) {
					const o = (j * cell + i) * 4;
					if (r.rgba[o + 3] <= 0) continue;
					used++;
					if (asMask) t.set(col * cell + i, row * cell + j, [255, 255, 255], 255);
					else t.set(col * cell + i, row * cell + j, [r.rgba[o], r.rgba[o + 1], r.rgba[o + 2]], r.rgba[o + 3]);
				}
			}
		}
	}
	return { tex: t, used };
}

/** every pose of the zombie sheet, in its row order: [type, step, windup, air] */
function zombiePoses() {
	const S = sheets;
	const poses = [];
	for (let t = 1; t <= 5; t++) for (let r = 0; r < S.STEPS; r++) poses.push([t, S.rowStep(r), 0, 0]);
	poses.push([2, 0, 0.5, 0], [2, 0, 1, 0], [5, 0, 0, 1]);
	return poses;
}

const ZOMBIE_RADIUS = [16, 16, 16, 17, 17, 16];

/** memoised cells: the colour sheet and its Fill mask share every raster */
function cache(fn) {
	const m = new Map();
	return (col, row) => {
		const key = `${col},${row}`;
		if (!m.has(key)) m.set(key, fn(col, row));
		return m.get(key);
	};
}

/**
 * Every character texture, in manifest order. `Tex` is tools/gen-world-art.mjs's texel canvas.
 */
export function characterArt(Tex) {
	load();
	const M = model;
	const S = sheets;
	const list = new M.PartList();
	const dirs = S.CHAR_DIRS;

	const zPoses = zombiePoses();
	const zombieCell = cache((col, row) => {
		const [type, step, windup, air] = zPoses[row];
		M.zombieParts(list, type, step, windup, air, ZOMBIE_RADIUS[type] / 18);
		return rasterCell(list, S.dirHeading(col), S.ZOMBIE_CELL);
	});
	const survivorCell = cache((col, row) => {
		if (row < S.SURVIVOR_ROW_DOWNED) {
			M.survivorParts(list, Math.floor(row / S.STEPS), S.rowStep(row % S.STEPS));
			return rasterCell(list, S.dirHeading(col), S.SURVIVOR_CELL);
		}
		const k = row - S.SURVIVOR_ROW_DOWNED;
		M.downedParts(list, Math.floor(k / 3), (k % 3) - 1);
		// the downed body is ringed in the survivor's red (MP-03, LEG-02), not the ink
		return rasterCell(list, S.dirHeading(col), S.SURVIVOR_CELL, M.OUTFIT_STYLES[0].flashTo.Lerp(M.OUTLINE_INK, 0.35));
	});
	const dogCell = cache((col, row) => {
		const pet = 4 + Math.floor(row / S.DOG_ROWS_EACH);
		const k = row % S.DOG_ROWS_EACH;
		if (k < S.STEPS) M.dogParts(list, pet, S.rowStep(k), 0, 1);
		else M.dogParts(list, pet, 0, k - S.STEPS - 1, 0);
		return rasterCell(list, S.dirHeading(col), S.DOG_CELL);
	});
	const birdCell = cache((col, row) => {
		const pet = 1 + Math.floor(row / S.BIRD_ROWS_EACH);
		const spreads = pet === 3 ? S.EAGLE_SPREADS : S.PIGEON_SPREADS;
		M.birdParts(list, pet, spreads[row % S.BIRD_ROWS_EACH]);
		return rasterCell(list, S.dirHeading(col), S.BIRD_CELL);
	});

	const out = [];
	const push = (name, kind, res, description) => out.push({ name, kind, tex: res.tex, description, character: true });
	push(
		"zombies",
		"sheet",
		sheet(Tex, S.ZOMBIE_CELL, dirs, S.ZOMBIE_ROWS, zombieCell, false),
		"zombies: 5 types x 5 strides, spitter wind-ups, jumper in the air; 32 headings (ART-09)",
	);
	push(
		"zombiesFill",
		"mask",
		sheet(Tex, S.ZOMBIE_CELL, dirs, S.ZOMBIE_ROWS, zombieCell, true),
		"zombies: white silhouettes of the same cells (tint: hit flash, lit fuse)",
	);
	push(
		"survivors",
		"sheet",
		sheet(Tex, S.SURVIVOR_CELL, dirs, S.SURVIVOR_ROWS, survivorCell, false),
		"survivors: 4 outfits x 5 strides, then downed crawls; 32 headings (ART-08)",
	);
	push(
		"survivorsFill",
		"mask",
		sheet(Tex, S.SURVIVOR_CELL, dirs, S.SURVIVOR_FILL_ROWS, survivorCell, true),
		"survivors: white silhouettes of the walking cells (tint: hit flash, poison)",
	);
	push(
		"dogs",
		"sheet",
		sheet(Tex, S.DOG_CELL, dirs, S.DOG_ROWS, dogCell, false),
		"pets: Carolina, Malamute, Doberman x 5 trot strides + 3 tail wags; 32 headings (ART-10)",
	);
	push(
		"birds",
		"sheet",
		sheet(Tex, S.BIRD_CELL, dirs, S.BIRD_ROWS, birdCell, false),
		"pets: Pigeon, White pigeon, Eagle x landed + 4 wing spreads; 32 headings (ART-10)",
	);
	return out;
}

/** the model and layout modules and the cell rasteriser, for tools that preview a pose without the whole sheet */
export function characterModules() {
	load();
	return { model, sheets, rasterCell };
}
