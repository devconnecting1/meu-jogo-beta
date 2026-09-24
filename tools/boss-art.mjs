/*
 * The bosses' pixel art (docs/DESIGN_RULES.md ART-13): tools/boss-model.mjs rasterised by the characters' own
 * rasteriser (tools/character-art.mjs rasterCell: the outline, the ramps, the light from the top left, the clean-up)
 * into one sheet per boss, laid out by src/client/view/charSheets.ts (BOSS_BAND: the 32 headings in two bands of 16,
 * or the rafflesia's vine beats), each with its white Fill and Rim masks for the hit flash. Called by
 * tools/gen-world-art.mjs next to the characters, so the sheets go through the same pipeline: design/world-art/*.png,
 * the manifest, `npm run cloud -- upload-art`, worldArtAssets.ts.
 *
 *   import { bossArt } from "./boss-art.mjs";
 *   for (const t of bossArt(Tex)) textures.push(t);   // { name, kind, tex, description }
 *
 * Nothing random: a rerun writes the same bytes, and the upload only sends what changed (by sha1).
 */
import { cellBounds, loadSheets, rasterCell } from "./character-art.mjs";
import * as B from "./boss-model.mjs";

/**
 * Every boss sheet: { name, cell, cols, rows, cells: [col, row, parts, heading][] }. The cells' order is charSheets.ts's.
 */
export function bossSpecs() {
	const S = loadSheets();
	const steps = [];
	for (let r = 0; r < S.STEPS; r++) steps.push(S.rowStep(r));
	const turning = (name, cell, poses) => {
		const cells = [];
		poses.forEach((parts, pose) => {
			for (let dir = 0; dir < S.CHAR_DIRS; dir++) {
				cells.push([S.bossColumn(dir), S.bossRow(pose, dir), parts, S.dirHeading(dir)]);
			}
		});
		return { name, cell, cols: S.BOSS_BAND, rows: poses.length * S.BOSS_BANDS, cells };
	};
	const giant = turning("bossGiant", S.GIANT_CELL, [...steps.map(s => B.giantParts(s)), B.giantParts(0, true)]);
	const hedgehog = turning(
		"bossHedgehog",
		S.HEDGEHOG_CELL,
		steps.map(s => B.hedgehogParts(s)),
	);
	const centipede = turning("bossCentipede", S.CENTIPEDE_CELL, [
		B.centipedeHeadParts(false),
		B.centipedeHeadParts(true),
		...steps.map(s => B.centipedeSegmentParts(s)),
		B.centipedeTailParts(),
	]);
	const vines = [];
	for (let f = 0; f < S.RAFFLESIA_FRAMES; f++) vines.push([f, 0, B.rafflesiaParts(S.rafflesiaSweep(f)), 0]);
	const rafflesia = {
		name: "bossRafflesia",
		cell: S.RAFFLESIA_CELL,
		cols: S.RAFFLESIA_FRAMES,
		rows: 1,
		cells: vines,
	};
	const check = (spec, poses) => {
		if (spec.rows !== poses * S.BOSS_BANDS)
			throw new Error(`${spec.name}: ${spec.rows} rows, charSheets.ts says ${poses}`);
	};
	check(giant, S.GIANT_POSES);
	check(hedgehog, S.HEDGEHOG_POSES);
	check(centipede, S.CENTIPEDE_POSES);
	return [giant, hedgehog, centipede, rafflesia];
}

const DESCRIPTIONS = {
	bossGiant: "boss 3, the giant: 3 strides + the lunge x 32 headings (two bands of 16) (ART-13)",
	bossHedgehog: "boss 4, the hedgehog: 3 strides x 32 headings (two bands of 16) (ART-13)",
	bossCentipede:
		"boss 1, the centipede: head (fangs shut, open), body segment x 3 leg beats, tail x 32 headings (ART-13)",
	bossRafflesia: "boss 2, the rafflesia: 12 beats of its six vines sweeping round (it never turns) (ART-13)",
};

/**
 * Every boss texture, in manifest order: the sheet, then its Fill (white silhouette: tint = the hit flash) and Rim
 * (white outline) masks. `Tex` is tools/gen-world-art.mjs's texel canvas. Every cell keeps a one-texel empty margin.
 */
export function bossArt(Tex) {
	const out = [];
	for (const spec of bossSpecs()) {
		const cell = spec.cell;
		const W = spec.cols * cell;
		const H = spec.rows * cell;
		if (W > 1024 || H > 1024) throw new Error(`${spec.name}: ${W}x${H} over 1024`);
		const color = new Tex(W, H);
		const fill = new Tex(W, H);
		const rim = new Tex(W, H);
		for (const [col, row, parts, heading] of spec.cells) {
			const r = rasterCell(parts, heading, cell);
			const b = cellBounds(r);
			if (b.x0 < 1 || b.y0 < 1 || b.x1 > cell - 2 || b.y1 > cell - 2) {
				throw new Error(`${spec.name} col ${col} row ${row}: touches the cell's margin (${JSON.stringify(b)})`);
			}
			for (let j = 0; j < cell; j++) {
				for (let i = 0; i < cell; i++) {
					const m = r.mask[j * cell + i];
					if (m === 0) continue;
					const o = (j * cell + i) * 4;
					const x = col * cell + i;
					const y = row * cell + j;
					color.set(x, y, [r.rgba[o], r.rgba[o + 1], r.rgba[o + 2]], 255);
					if (m === 1) fill.set(x, y, [255, 255, 255], 255);
					else rim.set(x, y, [255, 255, 255], 255);
				}
			}
		}
		out.push({ name: spec.name, kind: "sheet", tex: color, description: DESCRIPTIONS[spec.name] });
		out.push({
			name: `${spec.name}Fill`,
			kind: "mask",
			tex: fill,
			description: `${spec.name}: white silhouettes of the same cells (tint: hit flash)`,
		});
		out.push({
			name: `${spec.name}Rim`,
			kind: "mask",
			tex: rim,
			description: `${spec.name}: white outlines of the same cells (tint: the hit outline)`,
		});
	}
	return out;
}
