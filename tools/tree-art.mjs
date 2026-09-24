/*
 * Last Town trees (docs/DESIGN_RULES.md VEG-06, ART-02, ART-03): every crown of the town, baked into ONE greyscale
 * atlas (design/world-art/trees.png) that client/view/worldView.ts draws a cell of per tree (ImageRectOffset /
 * ImageRectSize, Pixelated). Written by tools/gen-world-art.mjs with the rest of the town (`npm run art:world`) and
 * uploaded with it (`upload-art`, the CI's `assets` job); until the atlas has an id -- or while the uploaded one is not
 * this PNG (its sha1, like every atlas) -- the trees are the flat circles of before (ART-01).
 *
 *   import { treeArt, treeAtlasModule, treeSheet } from "./tree-art.mjs";
 *   const art = treeArt({ species: TREE_SPECIES });   // { atlas, cells, trunk, bandH }
 *
 * WHAT IS IN IT. The kinds of shared/data/trees.ts, each in its `looks` crowns, every one drawn on its own from its own
 * seed (never a turned or mirrored copy): round, lobed (an oak's deep notches), wide (a spreading crown, airy, a limb
 * showing in its gaps), column (a tall narrow tree: small, tight, bright on top), pine (whorls of needled branches: a
 * star from above), young (a few small clumps round a thin crown), shrub (a low mound of bumps) and dead (bare limbs
 * forking into twigs). And the trunk: an 11 x 11 texel disc of bark with its root flares, the trunk's 44 u collision
 * box at 4 u a texel (COL-01: what stops a body is what is drawn).
 *
 * THE LIGHT is baked per crown, from the top left (ART-02): each crown is a height field of clumps (spheres) and limbs
 * (capsules); a texel's light is its surface normal against the light, a clump lower and to the right of a higher one
 * lies in its shadow, and the outline is darker on the side away from the light. Nothing is ever turned after it is
 * lit, so the lit side is the top left on every tree of the town.
 *
 * TWO BANDS, the same cells in each, one under the other (`bandH` apart):
 *   0 mask   the silhouette with its leaf (or bark) texture in three greys, tinted at runtime with the tree's own green
 *            (ImageColor3, ART-03) -- and, tinted black, its shadow on the ground;
 *   1 shade  the untinted light over it: white highlights on the lit clumps, black shadow between them and under, the
 *            outline. The trunk has no shade: its light is in its greys (it is tinted with the bark's colour).
 * Scale: 4 world units per texel (ART-02); a crown's cell is its kind's middle size (`box`), drawn at the tree's own
 * size (`canopyR`, within its kind's range): ±10 % of 4 u a texel.
 */

/** world units per texel */
const U = 4;
/** transparent texels right of and below every cell */
const GUTTER = 1;
/** the width the cells are shelved in */
const ATLAS_W = 512;
/** the trunk's cell: TOWN.TREE_TRUNK (44 u, the collision box) at 4 u a texel */
export const TRUNK_TEXELS = 11;

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
/** the light: from the top left and above (the town's convention, ART-02) */
const L = (() => {
	const v = [-0.55, -0.62, 0.56];
	const n = Math.hypot(...v);
	return v.map(x => x / n);
})();

function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** value noise over n x n texels with a lattice every `cell` texels, in [-1, 1] */
function noise(n, cell, seed) {
	const r = rng(seed);
	const m = Math.ceil(n / cell) + 2;
	const lat = new Float32Array(m * m).map(() => r() * 2 - 1);
	const s = t => t * t * (3 - 2 * t);
	const out = new Float32Array(n * n);
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const fx = x / cell;
			const fy = y / cell;
			const i = Math.floor(fx);
			const j = Math.floor(fy);
			const u = s(fx - i);
			const v = s(fy - j);
			const at = (a, b) => lat[b * m + a];
			const a = at(i, j) + (at(i + 1, j) - at(i, j)) * u;
			const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u;
			out[y * n + x] = a + (b - a) * v;
		}
	}
	return out;
}

// ---------------------------------------------------------------- the height field

/**
 * A crown as primitives over an n x n grid of texels (x right, y down, z up): every primitive is a capsule from
 * (x0, y0) to (x1, y1), its radius and height running from r0/z0 to r1/z1 (a clump is a capsule of length 0). A
 * texel's surface is the highest primitive over it; `part` tags what it is ("leaf", "limb").
 */
function field(n, prims) {
	const h = new Float32Array(n * n).fill(-1e9);
	const nx = new Float32Array(n * n);
	const ny = new Float32Array(n * n);
	const nz = new Float32Array(n * n);
	const part = new Array(n * n).fill(undefined);
	const along = new Float32Array(n * n);
	for (const p of prims) {
		const dx = p.x1 - p.x0;
		const dy = p.y1 - p.y0;
		const len2 = dx * dx + dy * dy;
		const rMax = Math.max(p.r0, p.r1);
		const xa = Math.max(0, Math.floor(Math.min(p.x0, p.x1) - rMax - 1));
		const xb = Math.min(n - 1, Math.ceil(Math.max(p.x0, p.x1) + rMax + 1));
		const ya = Math.max(0, Math.floor(Math.min(p.y0, p.y1) - rMax - 1));
		const yb = Math.min(n - 1, Math.ceil(Math.max(p.y0, p.y1) + rMax + 1));
		for (let y = ya; y <= yb; y++) {
			for (let x = xa; x <= xb; x++) {
				// the texel's centre against the segment
				const px = x + 0.5;
				const py = y + 0.5;
				const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - p.x0) * dx + (py - p.y0) * dy) / len2)) : 0;
				const qx = p.x0 + dx * t;
				const qy = p.y0 + dy * t;
				const r = p.r0 + (p.r1 - p.r0) * t;
				const ex = px - qx;
				const ey = py - qy;
				const d2 = ex * ex + ey * ey;
				if (d2 > r * r) continue;
				const k = Math.sqrt(Math.max(0, r * r - d2));
				const z = p.z0 + (p.z1 - p.z0) * t + k;
				const i = y * n + x;
				if (z <= h[i]) continue;
				h[i] = z;
				nx[i] = ex / r;
				ny[i] = ey / r;
				nz[i] = k / r;
				part[i] = p.part ?? "leaf";
				along[i] = t;
			}
		}
	}
	return { n, h, nx, ny, nz, part, along };
}

const clump = (x, y, r, z, part) => ({ x0: x, y0: y, x1: x, y1: y, r0: r, r1: r, z0: z, z1: z, part });
const limb = (x0, y0, x1, y1, r0, r1, z0, z1) => ({ x0, y0, x1, y1, r0, r1, z0, z1, part: "limb" });

/**
 * The two cells of a crown from its field: the mask (greyscale: the silhouette in three leaf or bark greys) and the
 * shade (the untinted light, the shadow between clumps, the outline). `tone(x, y, i)` gives a texel's grey.
 */
function paint(f, tone, { rim = [150, 96], lit = [78, 34], dark = [46, 92], limbDark = 120 } = {}) {
	const { n } = f;
	const inside = (x, y) => x >= 0 && y >= 0 && x < n && y < n && f.part[y * n + x] !== undefined;
	const mask = new Float32Array(n * n * 4);
	const shade = new Float32Array(n * n * 4);
	const set = (buf, i, c, a) => {
		buf[i * 4] = c[0];
		buf[i * 4 + 1] = c[1];
		buf[i * 4 + 2] = c[2];
		buf[i * 4 + 3] = a;
	};
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			if (!inside(x, y)) continue;
			const i = y * n + x;
			const g = tone(x, y, i);
			set(mask, i, [g, g, g], 255);
			let lam = f.nx[i] * L[0] + f.ny[i] * L[1] + f.nz[i] * L[2];
			// a texel lower and to the right of a higher clump lies in its shadow
			const ux = Math.round(x - 1.6);
			const uy = Math.round(y - 1.6);
			if (inside(ux, uy) && f.h[uy * n + ux] > f.h[i] + 2.2) lam -= 0.45;
			const v = lam + ((x + y) % 2 === 0 ? 0.04 : -0.04);
			if (f.part[i] === "limb") {
				// a limb in a gap of the leaves: dark wood, its lit top edge a little lighter
				set(shade, i, BLACK, v > 0.5 ? limbDark - 50 : limbDark);
			} else if (v > 0.8) set(shade, i, WHITE, lit[0]);
			else if (v > 0.6) set(shade, i, WHITE, lit[1]);
			else if (v > 0.35) {
				// the plain colour
			} else if (v > 0.12) set(shade, i, BLACK, dark[0]);
			else set(shade, i, BLACK, dark[1]);
		}
	}
	// the outline: every edge texel (the silhouette's and every gap's), darker on the side away from the light
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			if (!inside(x, y)) continue;
			const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
			if (!edge) continue;
			const lowerRight = !inside(x + 1, y) || !inside(x, y + 1);
			set(shade, y * n + x, BLACK, lowerRight ? rim[0] : rim[1]);
		}
	}
	return { n, mask, shade };
}

/** three leaf greys from a noise field: the tint shows a clumpy texture even without the shade */
function leafTone(nz, lo = -0.35, hi = 0.15) {
	return (_x, _y, i) => (nz[i] > hi ? 255 : nz[i] > lo ? 238 : 222);
}

// ---------------------------------------------------------------- the kinds

/** polar placement round the centre of an n-texel cell, squashed along a turned axis (aspect 1 = round) */
function placer(n, aspect, turn) {
	const c = n / 2;
	const ca = Math.cos(turn);
	const sa = Math.sin(turn);
	return (a, d) => {
		const u = Math.cos(a) * d * aspect;
		const v = Math.sin(a) * d;
		return [c + u * ca - v * sa, c + u * sa + v * ca];
	};
}

/** a clump that stays inside the cell (its edge at most `R` from the centre) */
function fit(prims, n, R, p) {
	const c = n / 2;
	const d = Math.hypot(p.x0 - c, p.y0 - c);
	if (d + p.r0 > R) p.r0 = p.r1 = Math.max(0.8, R - d);
	prims.push(p);
}

/** `fit`, but only a clump that sinks well into one already there: a crown never has a stray blob off its edge */
function attach(prims, n, R, p) {
	for (const q of prims) {
		if (q.part === "limb" || q.x0 !== q.x1 || q.y0 !== q.y1) continue;
		if (Math.hypot(p.x0 - q.x0, p.y0 - q.y0) < q.r0 + p.r0 * 0.15) {
			fit(prims, n, R, p);
			return;
		}
	}
}

/** round: a dome of clumps, a ring round it and small clumps scalloping the rim (a maple, a linden) */
function round(n, seed) {
	const r = rng(seed);
	const R = n / 2 - 1;
	const at = placer(n, 0.84 + r() * 0.32, r() * Math.PI);
	const prims = [];
	const [cx, cy] = at(r() * 6.28, r() * 0.08 * R);
	prims.push(clump(cx, cy, R * (0.46 + r() * 0.1), R * 0.32));
	// a ring of clumps, one side fuller than the other, and on some crowns a gap where a bough is missing
	const ring = 6 + Math.floor(r() * 5);
	const ph = r() * 6.28;
	const full = r() * 6.28;
	const gap = r() < 0.5 ? Math.floor(r() * ring) : -1;
	for (let i = 0; i < ring; i++) {
		if (i === gap) continue;
		const a = ph + (i / ring) * 6.28 + (r() - 0.5) * 0.6;
		const bulge = 1 + 0.14 * Math.cos(a - full);
		const [x, y] = at(a, R * (0.46 + r() * 0.16) * bulge);
		fit(prims, n, R, clump(x, y, R * (0.3 + r() * 0.16) * bulge, R * (0.06 + r() * 0.14)));
	}
	const rim = 8 + Math.floor(r() * 9);
	for (let i = 0; i < rim; i++) {
		const a = (i / rim) * 6.28 + r() * 0.5;
		if (gap >= 0 && Math.abs(((a - ph - (gap / ring) * 6.28 + 9.42) % 6.28) - 3.14) < 0.35) continue;
		const [x, y] = at(a, R * (0.74 + r() * 0.12) * (1 + 0.1 * Math.cos(a - full)));
		attach(prims, n, R, clump(x, y, R * (0.12 + r() * 0.1), 0));
	}
	for (let i = 0; i < 3; i++) {
		const [x, y] = at(r() * 6.28, R * (0.18 + r() * 0.14));
		prims.push(clump(x, y, R * (0.26 + r() * 0.07), R * (0.42 + r() * 0.1)));
	}
	return { prims, cell: 3.2 };
}

/** lobed: five or six big lobes of their own clumps round a smaller middle, deep notches between them (an oak) */
function lobed(n, seed) {
	const r = rng(seed);
	const R = n / 2 - 1;
	const at = placer(n, 0.86 + r() * 0.26, r() * Math.PI);
	const prims = [];
	prims.push(clump(...at(r() * 6.28, R * 0.06), R * 0.48, R * 0.3));
	const lobes = 4 + Math.floor(r() * 3);
	const ph = r() * 6.28;
	for (let i = 0; i < lobes; i++) {
		const a = ph + (i / lobes) * 6.28 + (r() - 0.5) * 0.5;
		const size = 0.82 + r() * 0.36;
		const d = R * (0.46 + r() * 0.1) * size;
		const [lx, ly] = at(a, d);
		// the lobe: a big mass with a smaller one on its crown, scalloped along its outer rim
		fit(prims, n, R, clump(lx, ly, R * 0.36 * size, R * (0.1 + r() * 0.1)));
		const [hx, hy] = at(a + (r() - 0.5) * 0.4, d * 0.7);
		prims.push(clump(hx, hy, R * 0.2 * size, R * (0.34 + r() * 0.08)));
		const k = 5 + Math.floor(r() * 2);
		for (let j = 0; j < k; j++) {
			const b = a + (j / (k - 1) - 0.5) * 1.5 + (r() - 0.5) * 0.25;
			const bd = R * 0.3 * size;
			attach(
				prims,
				n,
				R,
				clump(lx + Math.cos(b) * bd, ly + Math.sin(b) * bd, R * (0.13 + r() * 0.05) * size, R * 0.02),
			);
		}
	}
	for (let i = 0; i < 2; i++) prims.push(clump(...at(r() * 6.28, R * 0.16), R * 0.24, R * 0.44));
	return { prims, cell: 3.2 };
}

/** wide: a big airy spreading crown, clumps scattered over an oval with gaps, a limb or two showing between them */
function wide(n, seed) {
	const r = rng(seed);
	const R = n / 2 - 1;
	const aspect = 1.12 + r() * 0.14;
	const turn = r() * Math.PI;
	const prims = [];
	const c = n / 2;
	// the limbs, low under the leaves (seen in the gaps), always shorter than the leaves reach
	const limbs = 4 + Math.floor(r() * 2);
	const ph = r() * 6.28;
	for (let i = 0; i < limbs; i++) {
		const a = ph + (i / limbs) * 6.28 + (r() - 0.5) * 0.5;
		const L2 = R * (0.42 + r() * 0.14);
		prims.push(limb(c, c, c + Math.cos(a) * L2, c + Math.sin(a) * L2, 1.4, 0.8, 0, -1));
	}
	// masses of leaves over the oval (squashed across `turn`), each a few clumps, a low dome: airy, not a ball
	const ca = Math.cos(turn);
	const sa = Math.sin(turn);
	const oval = (a, d) => {
		const u = Math.cos(a) * d;
		const v = (Math.sin(a) * d) / aspect;
		return [c + (u * ca - v * sa) * R, c + (u * sa + v * ca) * R];
	};
	const masses = 6 + Math.floor(r() * 3);
	const mph = r() * 6.28;
	for (let i = 0; i < masses; i++) {
		const a = mph + (i / masses) * 6.28 + (r() - 0.5) * 0.45;
		const d = 0.44 + r() * 0.2;
		const [mx, my] = oval(a, d);
		const size = R * (0.19 + r() * 0.1);
		fit(prims, n, R, clump(mx, my, size, R * 0.14 * (1 - d * d) + r()));
		// its rim broken into smaller bumps, mostly on the outer side
		const k = 4 + Math.floor(r() * 2);
		for (let j = 0; j < k; j++) {
			const b = a + (j / (k - 1) - 0.5) * 2.6 + (r() - 0.5) * 0.4;
			const o = size * (0.75 + r() * 0.25);
			attach(
				prims,
				n,
				R,
				clump(mx + Math.cos(b) * o, my + Math.sin(b) * o, size * (0.36 + r() * 0.2), r() * 1.2),
			);
		}
	}
	// the middle: masses higher up over the limbs' fork, a gap or two left between them
	const mid = 3 + Math.floor(r() * 2);
	for (let i = 0; i < mid; i++) {
		const [x, y] = oval((i / mid) * 6.28 + r(), 0.08 + r() * 0.18);
		prims.push(clump(x, y, R * (0.2 + r() * 0.07), R * 0.26 + r()));
	}
	return { prims, cell: 3.2 };
}

/** column: a tall narrow tree seen from above -- small, tight, domed high (a hornbeam, a poplar) */
function column(n, seed) {
	const r = rng(seed);
	const R = n / 2 - 1;
	const at = placer(n, 0.9 + r() * 0.2, r() * Math.PI);
	const prims = [];
	prims.push(clump(...at(r() * 6.28, r() * 0.05 * R), R * 0.62, R * 0.55));
	const ring = 9 + Math.floor(r() * 3);
	const ph = r() * 6.28;
	for (let i = 0; i < ring; i++) {
		const a = ph + (i / ring) * 6.28 + (r() - 0.5) * 0.4;
		fit(prims, n, R, clump(...at(a, R * (0.58 + r() * 0.1)), R * (0.28 + r() * 0.08), R * 0.2));
	}
	const rim = 12 + Math.floor(r() * 5);
	for (let i = 0; i < rim; i++) {
		const a = (i / rim) * 6.28 + r() * 0.35;
		attach(prims, n, R, clump(...at(a, R * 0.84), R * (0.12 + r() * 0.05), 0));
	}
	return { prims, cell: 2.4 };
}

/** pine: whorls of branches from the leader, each a chain of needle clumps, the lower ones longer (a star from above) */
function pine(n, seed) {
	const r = rng(seed);
	const R = n / 2 - 1;
	const c = n / 2;
	const prims = [];
	// four whorls from the bottom (the widest) to the top, each a ring of needled tufts pointing out: from above, a
	// serrated disc in rings, the lit side of the cone to the top left
	const tiers = 4;
	let ph = r() * 6.28;
	for (let t = 0; t < tiers; t++) {
		const Rt = R * (1 - t * 0.23) * (0.95 + r() * 0.05);
		const k = 11 - t * 2 + Math.floor(r() * 2);
		const zt = t * R * 0.3;
		ph += Math.PI / k + (r() - 0.5) * 0.4;
		for (let i = 0; i < k; i++) {
			const a = ph + (i / k) * 6.28 + (r() - 0.5) * 0.4;
			const tip = Rt * (0.78 + r() * 0.22);
			const from = Rt * 0.3;
			const bend = (r() - 0.5) * 0.3;
			const steps = Math.max(3, Math.round((tip - from) / 1.1));
			for (let s = 0; s <= steps; s++) {
				const f = s / steps;
				const d = from + (tip - from) * f;
				const b = a + bend * f;
				// a broad bough narrowing to its tip: the tiers read as layers, the rim as a saw
				const rad = Math.max(0.95, R * (0.3 - 0.22 * f) * (1 - t * 0.12));
				const z = zt + R * 0.3 * (1 - d / R);
				fit(prims, n, R, clump(c + Math.cos(b) * d, c + Math.sin(b) * d, rad, z));
			}
		}
	}
	// the leader's tuft at the top
	prims.push(clump(c + (r() - 0.5), c + (r() - 0.5), R * 0.14, R * 1.0));
	return { prims, cell: 1.6, radial: true };
}

/** young: a thin crown, a few small clumps on short limbs round the leader, gaps between them */
function young(n, seed) {
	const r = rng(seed);
	const R = n / 2 - 1;
	const c = n / 2;
	const prims = [];
	const k = 4 + Math.floor(r() * 2);
	const ph = r() * 6.28;
	for (let i = 0; i < k; i++) {
		const a = ph + (i / k) * 6.28 + (r() - 0.5) * 0.7;
		const d = R * (0.42 + r() * 0.18);
		const x = c + Math.cos(a) * d;
		const y = c + Math.sin(a) * d;
		prims.push(limb(c, c, x, y, 0.9, 0.7, R * 0.1, 0));
		// a clump of leaves on each limb, and a smaller one beside it: a thin crown, the limbs showing between
		fit(prims, n, R, clump(x, y, R * (0.33 + r() * 0.08), R * 0.22));
		const b = a + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.3);
		fit(prims, n, R, clump(c + Math.cos(b) * d * 0.9, c + Math.sin(b) * d * 0.9, R * (0.2 + r() * 0.06), R * 0.1));
	}
	prims.push(clump(c, c, R * 0.28, R * 0.42));
	return { prims, cell: 2.2 };
}

/** shrub: a low mound of bumps, a little long one way */
function shrub(n, seed) {
	const r = rng(seed);
	const R = n / 2 - 1;
	const at = placer(n, 0.8 + r() * 0.3, r() * Math.PI);
	const prims = [];
	prims.push(clump(...at(0, 0), R * 0.5, R * 0.12));
	const k = 6 + Math.floor(r() * 3);
	const ph = r() * 6.28;
	for (let i = 0; i < k; i++) {
		const a = ph + (i / k) * 6.28 + (r() - 0.5) * 0.7;
		fit(prims, n, R, clump(...at(a, R * (0.42 + r() * 0.2)), R * (0.3 + r() * 0.16), 0));
	}
	return { prims, cell: 2 };
}

/** dead: bare limbs from the trunk, forking into twigs, one broken off short */
function dead(n, seed) {
	const r = rng(seed);
	const R = n / 2 - 1;
	const c = n / 2;
	const prims = [];
	const k = 5 + Math.floor(r() * 3);
	const ph = r() * 6.28;
	const broken = Math.floor(r() * k);
	const branch = (x, y, a, len, w, z, depth) => {
		const x1 = x + Math.cos(a) * len;
		const y1 = y + Math.sin(a) * len;
		prims.push({ ...limb(x, y, x1, y1, w, Math.max(0.62, w * 0.6), z, z - 1.5), part: "bark" });
		if (depth <= 0) return;
		const forks = 1 + (r() < 0.6 ? 1 : 0);
		for (let j = 0; j < forks; j++) {
			const f = 0.45 + r() * 0.35;
			const fx = x + Math.cos(a) * len * f;
			const fy = y + Math.sin(a) * len * f;
			const side = j === 0 ? (r() < 0.5 ? -1 : 1) : -1;
			branch(fx, fy, a + side * (0.4 + r() * 0.35), len * (0.42 + r() * 0.16), w * 0.62, z - 1, depth - 1);
		}
	};
	for (let i = 0; i < k; i++) {
		const a = ph + (i / k) * 6.28 + (r() - 0.5) * 0.5;
		const len = i === broken ? R * 0.34 : R * (0.66 + r() * 0.28);
		branch(c, c, a, len, 1.7, R * 0.4, i === broken ? 0 : 2);
	}
	prims.push(clump(c, c, 2.4, R * 0.46, "bark"));
	return { prims, cell: 1.5, bark: true };
}

const KINDS = { round, lobed, wide, column, pine, young, shrub, dead };

/** one crown: its field, painted */
function crown(kind, n, seed) {
	const make = KINDS[kind];
	if (make === undefined) throw new Error(`tree-art: no drawing for the kind "${kind}"`);
	const shape = make(n, seed);
	const f = field(n, shape.prims);
	let tone;
	if (shape.bark) {
		// bark: a grain along each limb, pale on the weathered wood
		const nzA = noise(n, 1.4, seed + 5);
		tone = (_x, _y, i) => (nzA[i] > 0.25 ? 255 : nzA[i] > -0.3 ? 236 : 214);
	} else if (shape.radial) {
		// needles: streaks running out from the leader
		const c = n / 2;
		const nzA = noise(n, shape.cell, seed + 3);
		tone = (x, y, i) => {
			const a = Math.atan2(y + 0.5 - c, x + 0.5 - c);
			const streak = Math.sin(a * 19 + Math.hypot(x - c, y - c) * 0.3 + seed);
			const v = nzA[i] * 0.7 + streak * 0.35;
			return v > 0.3 ? 255 : v > -0.3 ? 236 : 218;
		};
	} else tone = leafTone(noise(n, shape.cell, seed + 3));
	const painted = paint(f, tone, shape.bark ? { rim: [128, 78], lit: [84, 38], dark: [34, 70] } : {});
	return painted;
}

/** the trunk from above: a disc of bark (lit top left, in its greys: it has no shade) and three or four root flares */
function trunk(seed) {
	const n = TRUNK_TEXELS;
	const r = rng(seed);
	const c = n / 2;
	const prims = [clump(c, c, 4.6, 3, "limb")];
	// three low flares where the roots go in, at uneven angles (four square ones read as a diamond)
	const ph = r() * 6.28;
	for (const [a, len] of [
		[ph, 5.2],
		[ph + 2.3 + r() * 0.4, 5],
		[ph + 4.1 + r() * 0.5, 5.3],
	]) {
		prims.push(limb(c, c, c + Math.cos(a) * len, c + Math.sin(a) * len, 1.5, 0.9, 1.4, 0));
	}
	const f = field(n, prims);
	const nzA = noise(n, 1.5, seed + 1);
	const inside = (x, y) => x >= 0 && y >= 0 && x < n && y < n && f.part[y * n + x] !== undefined;
	const px = new Float32Array(n * n * 4);
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			if (!inside(x, y)) continue;
			const i = y * n + x;
			const lam = f.nx[i] * L[0] + f.ny[i] * L[1] + f.nz[i] * L[2] + nzA[i] * 0.12;
			let g = lam > 0.75 ? 255 : lam > 0.5 ? 232 : lam > 0.25 ? 206 : 176;
			const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
			if (edge) g = !inside(x + 1, y) || !inside(x, y + 1) ? 96 : 128;
			px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = g;
			px[i * 4 + 3] = 255;
		}
	}
	return { n, mask: px };
}

// ---------------------------------------------------------------- the atlas

/** shelf-packs square cells of side `n` (x, y in texels inside the band) */
function shelve(sizes) {
	let x = 0;
	let y = 0;
	let rowH = 0;
	const at = [];
	for (const n of sizes) {
		if (x + n + GUTTER > ATLAS_W) {
			x = 0;
			y += rowH;
			rowH = 0;
		}
		at.push([x, y]);
		x += n + GUTTER;
		rowH = Math.max(rowH, n + GUTTER);
	}
	return { at, h: y + rowH };
}

/** a stable seed per kind and look (the drawings never move when a kind is added after them) */
function seedOf(kind, look) {
	let h = 2166136261;
	for (const ch of kind) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
	return (h ^ Math.imul(look + 1, 2654435761)) >>> 0;
}

/**
 * The atlas: every look of every kind (TREE_SPECIES order), then the trunk, shelved once; band 0 the masks (and the
 * trunk), band 1 the shades. `species` is TREE_SPECIES of shared/data/trees.ts.
 */
export function treeArt({ species }) {
	const crowns = [];
	for (const sp of species) {
		for (let look = 0; look < sp.looks; look++)
			crowns.push({ kind: sp.name, look, ...crown(sp.name, sp.box, seedOf(sp.name, look)) });
	}
	const stump = trunk(seedOf("trunk", 0));
	const { at, h: bandH } = shelve([...crowns.map(c => c.n), stump.n]);
	const W = ATLAS_W;
	const H = bandH * 2;
	const data = Buffer.alloc(W * H * 4);
	const blit = (px, n, x0, y0) => {
		for (let y = 0; y < n; y++) {
			for (let x = 0; x < n; x++) {
				const si = (y * n + x) * 4;
				if (px[si + 3] <= 0) continue;
				const di = ((y0 + y) * W + x0 + x) * 4;
				for (let k = 0; k < 4; k++) data[di + k] = Math.max(0, Math.min(255, Math.round(px[si + k])));
			}
		}
	};
	const cells = species.map(() => []);
	crowns.forEach((c, i) => {
		const [x0, y0] = at[i];
		blit(c.mask, c.n, x0, y0);
		blit(c.shade, c.n, x0, bandH + y0);
		cells[species.findIndex(s => s.name === c.kind)].push([x0, y0, c.n]);
	});
	const [tx, ty] = at[crowns.length];
	blit(stump.mask, stump.n, tx, ty);
	return {
		atlas: { w: W, h: H, toCanvas: () => ({ w: W, h: H, data }) },
		cells,
		trunk: [tx, ty, stump.n],
		bandH,
		names: species.map(s => s.name),
	};
}

/** src/client/view/treeAtlas.ts: the cells (the atlas's id is WORLD_ART.<name>) */
export function treeAtlasModule(art, name) {
	const L2 = [];
	L2.push("// generated by tools/gen-world-art.mjs (tools/tree-art.mjs) — do not edit");
	L2.push(
		`// the town's trees (DESIGN_RULES VEG-06): design/world-art/${name}.png; its id is WORLD_ART.${name} (worldArtAssets.ts)`,
	);
	L2.push("");
	L2.push("/** the atlas's size in texels (one texel = 4 world units) */");
	L2.push(`export const TREE_ATLAS_W = ${art.atlas.w};`);
	L2.push(`export const TREE_ATLAS_H = ${art.atlas.h};`);
	L2.push("");
	L2.push(
		"/** band 0 holds the crowns' masks and the trunk; a crown's shade is the same cell `TREE_BAND_H` lower */",
	);
	L2.push(`export const TREE_BAND_H = ${art.bandH};`);
	L2.push("");
	L2.push("/**");
	L2.push(
		" * Per kind (shared/data/trees.ts TREE_SPECIES order), per look: [x, y, n] -- the top-left corner of the crown's",
	);
	L2.push(" * mask in band 0 and the side of its square cell, in texels.");
	L2.push(" */");
	L2.push("export const TREE_CELLS: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [");
	art.cells.forEach((list, i) => {
		L2.push(`\t// ${art.names[i]}`);
		L2.push("\t[");
		for (const c of list) L2.push(`\t\t[${c.join(", ")}],`);
		L2.push("\t],");
	});
	L2.push("];");
	L2.push("");
	L2.push(
		"/** the trunk's cell (band 0 only: its light is in its greys), [x, y, n]: the 44 u trunk at 4 u a texel */",
	);
	L2.push(`export const TREE_TRUNK_CELL: readonly [number, number, number] = [${art.trunk.join(", ")}];`);
	L2.push("");
	return L2.join("\n");
}

/**
 * docs/art/tree-sheet.png: every look of every kind magnified 3x in each of its greens, on the park's grass, as the game
 * composes it (mask x tint, then the shade over it, the shadow on the ground under it, the trunk under the crown).
 */
export function treeSheet(art, drawText, C, species) {
	const Z = 3;
	const canvas = art.atlas.toCanvas();
	const px = (x, y) => canvas.data.subarray((y * canvas.w + x) * 4, (y * canvas.w + x) * 4 + 4);
	const pad = 10;
	const labelW = 70;
	const rows = [];
	species.forEach((sp, s) => {
		sp.tints.forEach((t, k) => rows.push({ s, sp, tint: mixTint(C, t), label: k === 0 ? sp.name : "" }));
	});
	const cellW = 52 * Z;
	const cols = Math.max(...species.map(s => s.looks));
	const W = labelW + cols * cellW + pad;
	const heights = rows.map(r => r.sp.box * Z + 10);
	const H = pad + heights.reduce((a, b) => a + b, 0) + pad;
	const img = { w: W, h: H, data: Buffer.alloc(W * H * 4) };
	const grass = C.parkGrass;
	for (let i = 0; i < W * H; i++) {
		img.data[i * 4] = grass[0];
		img.data[i * 4 + 1] = grass[1];
		img.data[i * 4 + 2] = grass[2];
		img.data[i * 4 + 3] = 255;
	}
	const over = (X, Y, c, a) => {
		if (X < 0 || Y < 0 || X >= W || Y >= H || a <= 0) return;
		const di = (Y * W + X) * 4;
		for (let k = 0; k < 3; k++) img.data[di + k] = Math.round(img.data[di + k] * (1 - a) + c[k] * a);
	};
	let y0 = pad;
	rows.forEach((row, ri) => {
		const { s, sp, tint } = row;
		if (row.label !== "") drawText(img, row.label, 6, y0 + 4, 1, [235, 235, 235]);
		art.cells[s].forEach(([cx, cy, n], look) => {
			const X0 = labelW + look * cellW;
			const size = n * Z;
			// the shadow down and to the right, then the trunk, then the crown and its light
			const sh = Math.round((sp.lift / U) * Z * 0.9);
			for (let yy = 0; yy < size; yy++) {
				for (let xx = 0; xx < size; xx++) {
					const m = px(cx + Math.floor(xx / Z), cy + Math.floor(yy / Z));
					if (m[3] > 0) over(X0 + xx + Math.round(sh * 0.27), y0 + yy + sh, BLACK, 0.26);
				}
			}
			if (!sp.low) {
				const [tx, ty, tn] = art.trunk;
				const off = Math.floor((size - tn * Z) / 2);
				for (let yy = 0; yy < tn * Z; yy++) {
					for (let xx = 0; xx < tn * Z; xx++) {
						const m = px(tx + Math.floor(xx / Z), ty + Math.floor(yy / Z));
						if (m[3] > 0)
							over(
								X0 + off + xx,
								y0 + off + yy,
								C.treeTrunk.map(v => (v * m[0]) / 255),
								1,
							);
					}
				}
			}
			for (let yy = 0; yy < size; yy++) {
				for (let xx = 0; xx < size; xx++) {
					const m = px(cx + Math.floor(xx / Z), cy + Math.floor(yy / Z));
					if (m[3] > 0)
						over(
							X0 + xx,
							y0 + yy,
							tint.map(v => (v * m[0]) / 255),
							m[3] / 255,
						);
					const o = px(cx + Math.floor(xx / Z), art.bandH + cy + Math.floor(yy / Z));
					if (o[3] > 0) over(X0 + xx, y0 + yy, [o[0], o[1], o[2]], o[3] / 255);
				}
			}
		});
		y0 += heights[ri];
	});
	return img;
}

/** a tint of shared/data/trees.ts ([a, b, k] over the palette) as RGB */
export function mixTint(C, [a, b, k]) {
	const A = C[a];
	const B = C[b];
	if (A === undefined || B === undefined) throw new Error(`tree-art: no palette colour ${A === undefined ? a : b}`);
	return [A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k];
}
