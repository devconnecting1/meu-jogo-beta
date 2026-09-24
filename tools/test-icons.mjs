#!/usr/bin/env node
/*
 * The item icons' atlas (docs/DESIGN_RULES.md UI-11): every icon and glyph of shared/data/itemIcons.ts rasterised
 * into one PNG by tools/gen-world-art.mjs (tools/icon-atlas.mjs), uploaded with the town's art, and drawn by
 * client/ui/itemIcon.ts as ONE ImageLabel per icon instead of 10-50 Frames. With no id the drawer is exactly the
 * Frame drawer it was.
 *
 *   npm run test:icons
 *   node tools/test-icons.mjs --golden     # rewrites tools/golden/item-icons-flat.json from the CURRENT src
 *                                          # (only when the Frame drawing changes on purpose)
 *   node tools/test-icons.mjs --render docs/art/icons   # also writes before.png (Frames) / after.png (atlas)
 *
 * What this proves:
 *   1. THE ATLAS. The manifest's atlas entry, the PNG and the generated client/ui/itemIconAtlas.ts agree; every
 *      icon has a cell and a dimmed cell, every glyph a cell; the cells stay inside the atlas (<= 1024 x 1024, the
 *      upload limit), never overlap, keep a 2-texel transparent gutter and sit on even texels; each cell is what the
 *      Frame drawer paints at one screen pixel per texel, texel for texel, in ICON_ART (the dimmed cell in the
 *      drawer's greys, a glyph in white for ImageColor3 to tint); nothing else is painted; the id in
 *      worldArtAssets.ts is "" or belongs to THIS PNG (assets.json's sha1), and the boot's preload fetches it with
 *      the town's textures.
 *   2. NO ID, NO CHANGE. With no atlas id every icon, dimmed icon and glyph, at five sizes (and in Scale, before the
 *      view knows its size), in one pooled view and in a reserved one, draws the same Frames with the same colours
 *      as before the atlas: the digest of every Frame's properties after every draw equals
 *      tools/golden/item-icons-flat.json, recorded from the drawer of 38c363a. And no ImageLabel exists.
 *   3. WITH AN ID. Every icon and glyph draws as ONE visible ImageLabel (no Frame run at all): the atlas's id,
 *      ImageRectOffset / ImageRectSize = its cell (the dimmed cell when dimmed), Pixelated, untinted for art and
 *      tinted with the ink for a glyph, opaque, filling the same square the Frames fill. Rasterised, it is the Frame
 *      drawing pixel for pixel wherever a texel is a whole number of screen pixels, and within one texel edge
 *      elsewhere. A reserved view builds one ImageLabel, not its reserve of Frames.
 *   4. NO CHURN. Hundreds of repaints, clears and resizes create no Instance; the same icon again writes nothing,
 *      another icon of the same size writes only its ImageRectOffset; the rect Vector2s are cached, one per cell.
 *   5. THE FALLBACK. When the atlas cannot be fetched every live view repaints as its Frame drawing -- the same
 *      digest as a view that never had the atlas -- and views built afterwards reserve their Frames again.
 *   6. FIT "DRAWN" (the item views: hotbar, Bag, item card, Survivor loadout). Every icon and glyph, at 16-48 px, with
 *      the Frames and with the atlas: the centre of what it draws within half a pixel (Frames) / 1 px (atlas) of the
 *      square's centre; the "cell" drawing pixel for pixel, moved by whole pixels; drawnRects() exactly the runs the
 *      view places; the same centring in Scale before the size is known; no churn. The default fit ("cell") is what
 *      parts 1-5 measure, unchanged.
 *
 * Pure Node (>= 18) + the project's TypeScript on tools/ui-shim.mjs (the counted fake Instance tree).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installUiShims } from "./ui-shim.mjs";
import { decodePNG, encodePNG } from "./png-lite.mjs";

const GOLDEN_MODE = process.argv.includes("--golden");
const ui = installUiShims({ seed: 1, viewport: [1120, 630] });
const { SRC, ROOT, require, measure, flush } = ui;
const GOLDEN = join(ROOT, "tools", "golden", "item-icons-flat.json");
const ART_DIR = join(ROOT, "design", "world-art");

const Icon = require(join(SRC, "client/ui/itemIcon.ts"));
const WA = require(join(SRC, "client/view/worldArt.ts"));
const { WORLD_ART, WORLD_ART_NAMES } = require(join(SRC, "client/view/worldArtAssets.ts"));
const { ITEM_ICONS, ICON_GLYPHS } = require(join(SRC, "shared/data/itemIcons.ts"));
const { THEME, GAME } = require(join(SRC, "client/ui/theme.ts"));
flush();

let failures = 0;
function check(ok, what, detail) {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail !== undefined && detail !== "" ? `  (${detail})` : ""}`);
	if (!ok) failures++;
	return ok;
}
function section(title) {
	console.log(`\n${title}`);
}

const ICON_KEYS = Object.keys(ITEM_ICONS);
const GLYPH_KEYS = Object.keys(ICON_GLYPHS);
/** the sizes a view is measured at: whole multiples of 16 and 8, and sizes that are not (a phone's tiles) */
const SIZES = [48, 44, 32, 20, 0];

const root = new Instance("Frame");
root.Name = "IconTest";

/** a view `size` px square (0: never measured, the Scale path) */
function viewAt(size, reserve = 0) {
	const v = Icon.IconView(root, "ItemIcon", 0, 0, 48, 1, reserve);
	if (size > 0) v.frame.AbsoluteSize = new Vector2(size, size);
	flush();
	return v;
}

const fmtN = v => (typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v));
const fmtUDim2 = u => (u === undefined ? "-" : [u.X.Scale, u.X.Offset, u.Y.Scale, u.Y.Offset].map(fmtN).join(" "));
const fmtColor = c => (c === undefined ? "-" : [c.R, c.G, c.B].map(fmtN).join(" "));

/** everything a player could see of a view: its attributes and every child's drawn properties, in child order */
function snap(view) {
	const f = view.frame;
	const kids = f
		.GetChildren()
		.map(k =>
			[
				k.ClassName,
				k.Name,
				k.Visible,
				fmtUDim2(k.Position),
				fmtUDim2(k.Size),
				fmtColor(k.BackgroundColor3),
				fmtN(k.BackgroundTransparency),
				k.ZIndex,
				k.BorderSizePixel,
			].join(","),
		);
	return [f.GetAttribute("Icon"), f.GetAttribute("Dim"), ...kids].join(";");
}

/** the draw sequence every digest runs: each icon, each icon dimmed, each glyph in two inks, a clear, a redraw */
function drawSequence(view, onStep) {
	for (const k of ICON_KEYS) {
		Icon.drawIcon(view, k);
		onStep(view);
	}
	for (const k of ICON_KEYS) {
		Icon.drawIcon(view, k, { dim: true });
		onStep(view);
	}
	for (const ink of [THEME.foreground, GAME.success]) {
		for (const k of GLYPH_KEYS) {
			Icon.drawIcon(view, k, { ink });
			onStep(view);
		}
	}
	Icon.clearIcon(view);
	onStep(view);
	Icon.drawIcon(view, ICON_KEYS[0]);
	onStep(view);
	Icon.drawIcon(view, "no_such_icon");
	onStep(view);
}

/** the digest of the Frame drawing: per size, a pooled view through the whole sequence; and a reserved view */
function flatDigests() {
	const out = {};
	for (const size of SIZES) {
		const h = createHash("sha1");
		let steps = 0;
		const view = viewAt(size);
		drawSequence(view, v => {
			h.update(snap(v));
			h.update("\n");
			steps++;
		});
		// a resize after the fact re-places every run on the new grid
		if (size > 0) {
			view.frame.AbsoluteSize = new Vector2(size + 8, size + 8);
			flush();
			h.update(snap(view));
		}
		out[`pooled${size}`] = { steps, sha1: h.digest("hex") };
		view.frame.Destroy();
	}
	const h = createHash("sha1");
	const reserve = Icon.maxItemFrames();
	const reserved = viewAt(48, reserve);
	h.update(snap(reserved));
	Icon.drawItemIcon(reserved, 1, 10);
	h.update(snap(reserved));
	Icon.drawItemIcon(reserved, 3, 12, true);
	h.update(snap(reserved));
	out.reserved48 = { steps: 3, reserve, sha1: h.digest("hex") };
	reserved.frame.Destroy();
	return out;
}

// ================================================================ 2 (first: the golden is recorded from it)

/** the uploads as they are, with the atlas's id set to `id` ("" = no atlas: the Frame drawing) */
function setAtlas(id) {
	const ids = {};
	for (const [name, t] of Object.entries(WORLD_ART)) ids[name] = t.id;
	ids.itemIcons = id;
	WA.overrideWorldArt(ids);
}

setAtlas("");
const flat = flatDigests();
if (GOLDEN_MODE) {
	const golden = {
		note: "digests of client/ui/itemIcon.ts drawing every icon, dimmed icon and glyph with Frames (no atlas id): tools/test-icons.mjs --golden",
		recordedFrom: "38c363a (the Frame drawer before the atlas)",
		digests: flat,
	};
	writeFileSync(GOLDEN, `${JSON.stringify(golden, undefined, "\t")}\n`);
	console.log(`wrote ${GOLDEN}`);
	for (const [k, v] of Object.entries(flat)) console.log(`  ${k.padEnd(12)} ${v.steps} steps  ${v.sha1}`);
	process.exit(0);
}

// ================================================================ 1. the atlas

section("1) the atlas: manifest, PNG and itemIconAtlas.ts agree; each cell is its icon's Frames, texel for texel");

const FAKE = "rbxassetid://910000001";
const manifest = JSON.parse(readFileSync(join(ART_DIR, "manifest.json"), "utf8"));
const entry = manifest.textures.find(t => t.kind === "atlas");
const { ICON_ATLAS_CELLS, ICON_ATLAS_W, ICON_ATLAS_H } = require(join(SRC, "client/ui/itemIconAtlas.ts"));
const png = readFileSync(join(ART_DIR, entry?.file ?? "itemIcons.png"));
const atlasImg = decodePNG(png);
const GUTTER = 2;
{
	check(
		entry !== undefined && entry.name === "itemIcons" && entry.file === "itemIcons.png",
		"the manifest lists the atlas (kind atlas, itemIcons.png): npm run cloud -- upload-art sends it with the rest",
	);
	check(
		atlasImg.w === entry.w && atlasImg.h === entry.h && entry.w <= 1024 && entry.h <= 1024,
		"its PNG decodes at the manifest's size, within Roblox's 1024 x 1024 image",
		`${atlasImg.w} x ${atlasImg.h}`,
	);
	check(
		ICON_ATLAS_W === entry.w && ICON_ATLAS_H === entry.h,
		"itemIconAtlas.ts has the same size",
		`${ICON_ATLAS_W} x ${ICON_ATLAS_H}`,
	);
	const missing = [
		...ICON_KEYS.filter(k => entry.cells[k] === undefined || entry.dim[k] === undefined),
		...GLYPH_KEYS.filter(k => entry.cells[k] === undefined),
	];
	check(
		missing.length === 0 &&
			Object.keys(entry.cells).length === ICON_KEYS.length + GLYPH_KEYS.length &&
			Object.keys(entry.dim).length === ICON_KEYS.length,
		`every one of the ${ICON_KEYS.length} icons has a cell and a dimmed cell, every one of the ${GLYPH_KEYS.length} glyphs a cell (npm run art:world after changing itemIcons.ts)`,
		missing.join(", "),
	);
	const drift = Object.keys(entry.cells).filter(k => {
		const c = ICON_ATLAS_CELLS[k];
		const m = entry.cells[k];
		const d = entry.dim[k] ?? m;
		return c === undefined || c[0] !== m[0] || c[1] !== m[1] || c[2] !== m[2] || c[3] !== d[0] || c[4] !== d[1];
	});
	check(
		drift.length === 0 && Object.keys(ICON_ATLAS_CELLS).length === Object.keys(entry.cells).length,
		"itemIconAtlas.ts has exactly the manifest's cells (the client draws what was uploaded)",
		drift.join(", "),
	);
	// every rect, its gutter included: inside the atlas, on even texels, apart from every other
	const rects = [
		...Object.entries(entry.cells).map(([k, r]) => [k, ...r]),
		...Object.entries(entry.dim).map(([k, r]) => [`${k}@dim`, ...r]),
	];
	const outside = rects.filter(
		([, x, y, w, h]) => x < 0 || y < 0 || x + w + GUTTER > entry.w || y + h + GUTTER > entry.h,
	);
	const odd = rects.filter(([, x, y, w, h]) => x % 2 !== 0 || y % 2 !== 0 || w % 2 !== 0 || h % 2 !== 0);
	const overlaps = [];
	for (let i = 0; i < rects.length; i++) {
		for (let j = i + 1; j < rects.length; j++) {
			const [a, ax, ay, aw, ah] = rects[i];
			const [b, bx, by, bw, bh] = rects[j];
			const apart =
				ax + aw + GUTTER <= bx || bx + bw + GUTTER <= ax || ay + ah + GUTTER <= by || by + bh + GUTTER <= ay;
			if (!apart) overlaps.push(`${a} x ${b}`);
		}
	}
	check(
		outside.length === 0,
		`the ${rects.length} cells and their ${GUTTER}-texel gutters stay inside the atlas`,
		outside.map(r => r[0]).join(", "),
	);
	check(overlaps.length === 0, "no two cells overlap, gutters included", overlaps.slice(0, 5).join(", "));
	check(
		odd.length === 0,
		"every cell starts on an even texel (a mip level down never mixes two cells)",
		odd.map(r => r[0]).join(", "),
	);
}

const WHITE = new Color3(1, 1, 1);
const byte = v => Math.round(v * 255);

/** the Frame drawing of a view, rasterised: its visible runs in ZIndex order (ties in child order), RGBA w x h */
function rasterFrames(view, w, h) {
	const out = Buffer.alloc(w * h * 4);
	const runs = view.frame
		.GetChildren()
		.filter(k => k.ClassName === "Frame" && k.Visible)
		.map((f, i) => ({ f, i }))
		.sort((a, b) => a.f.ZIndex - b.f.ZIndex || a.i - b.i);
	for (const { f } of runs) {
		const c = f.BackgroundColor3;
		const x0 = f.Position.X.Offset;
		const y0 = f.Position.Y.Offset;
		for (let y = y0; y < y0 + f.Size.Y.Offset; y++) {
			for (let x = x0; x < x0 + f.Size.X.Offset; x++) {
				if (x < 0 || y < 0 || x >= w || y >= h) continue;
				const o = (y * w + x) * 4;
				out[o] = byte(c.R);
				out[o + 1] = byte(c.G);
				out[o + 2] = byte(c.B);
				out[o + 3] = 255;
			}
		}
	}
	return out;
}

/** the atlas drawing of a view, rasterised the way tools/gui-raster.mjs samples a Pixelated ImageLabel */
function rasterImage(view, w, h) {
	const out = Buffer.alloc(w * h * 4);
	const img = view.frame.GetChildren().find(k => k.ClassName === "ImageLabel" && k.Visible);
	if (img === undefined) return out;
	const lx = img.Position.X.Offset;
	const ly = img.Position.Y.Offset;
	const lw = img.Size.X.Offset;
	const lh = img.Size.Y.Offset;
	const ro = img.ImageRectOffset;
	const rs = img.ImageRectSize;
	const tint = img.ImageColor3;
	for (let y = Math.max(0, ly); y < Math.min(h, ly + lh); y++) {
		for (let x = Math.max(0, lx); x < Math.min(w, lx + lw); x++) {
			const tx = Math.floor(ro.X + ((x + 0.5 - lx) / lw) * rs.X);
			const ty = Math.floor(ro.Y + ((y + 0.5 - ly) / lh) * rs.Y);
			const s = (ty * atlasImg.w + tx) * 4;
			if (atlasImg.data[s + 3] === 0) continue;
			const o = (y * w + x) * 4;
			out[o] = Math.round(atlasImg.data[s] * tint.R);
			out[o + 1] = Math.round(atlasImg.data[s + 1] * tint.G);
			out[o + 2] = Math.round(atlasImg.data[s + 2] * tint.B);
			out[o + 3] = 255;
		}
	}
	return out;
}

/** a cell of the PNG as RGBA (transparent texels as 0 0 0 0) */
function cellPixels(x0, y0, n) {
	const out = Buffer.alloc(n * n * 4);
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const s = ((y0 + y) * atlasImg.w + x0 + x) * 4;
			if (atlasImg.data[s + 3] === 0) continue;
			atlasImg.data.copy(out, (y * n + x) * 4, s, s + 4);
		}
	}
	return out;
}

setAtlas("");
{
	// the Frame drawer at one screen pixel per texel IS the grid: each cell must be exactly that
	const wrong = [];
	const covered = new Uint8Array(atlasImg.w * atlasImg.h);
	const cover = (x0, y0, n) => {
		for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) covered[(y0 + y) * atlasImg.w + x0 + x] = 1;
	};
	for (const k of ICON_KEYS) {
		for (const dim of [false, true]) {
			const [x, y] = dim ? entry.dim[k] : entry.cells[k];
			const v = viewAt(16);
			Icon.drawIcon(v, k, { dim });
			if (!rasterFrames(v, 16, 16).equals(cellPixels(x, y, 16))) wrong.push(`${k}${dim ? "@dim" : ""}`);
			v.frame.Destroy();
			cover(x, y, 16);
		}
	}
	for (const k of GLYPH_KEYS) {
		const [x, y] = entry.cells[k];
		const v = viewAt(8);
		Icon.drawIcon(v, k, { ink: WHITE });
		if (!rasterFrames(v, 8, 8).equals(cellPixels(x, y, 8))) wrong.push(k);
		v.frame.Destroy();
		cover(x, y, 8);
	}
	check(
		wrong.length === 0,
		`every cell is its Frame drawing at 1 px per texel: ${ICON_KEYS.length} icons in ICON_ART, their dimmed copies in the drawer's greys, ${GLYPH_KEYS.length} glyphs in white`,
		wrong.slice(0, 8).join(", "),
	);
	let stray = 0;
	let partial = 0;
	for (let i = 0; i < covered.length; i++) {
		const a = atlasImg.data[i * 4 + 3];
		if (!covered[i] && a !== 0) stray++;
		if (a !== 0 && a !== 255) partial++;
	}
	check(stray === 0, "nothing is painted outside the cells (the gutters are transparent)", `${stray} texels`);
	check(partial === 0, "every texel is opaque or empty, like a Frame", `${partial}`);
}
{
	const assetsPath = join(ART_DIR, "assets.json");
	const assets = existsSync(assetsPath) ? JSON.parse(readFileSync(assetsPath, "utf8")) : {};
	const id = WORLD_ART.itemIcons?.id;
	const sha1 = createHash("sha1").update(png).digest("hex");
	check(
		WORLD_ART.itemIcons !== undefined && WORLD_ART.itemIcons.w === entry.w && WORLD_ART.itemIcons.h === entry.h,
		"worldArtAssets.ts lists the atlas at its size",
	);
	check(
		id === "" ||
			(/^rbxassetid:\/\/\d+$/.test(id) && assets.ids?.itemIcons === id && assets.sha1?.itemIcons === sha1),
		'its id is "" or the upload of THIS PNG (a stale atlas would draw the wrong icons, so gen-world-art leaves it out)',
		id === "" ? "no id yet: the Frames draw every icon" : id,
	);
	check(
		WORLD_ART_NAMES.includes("itemIcons"),
		"the boot's preload fetches it with the town (worldArt.ts gives it up on its own)",
	);
}

// ================================================================ 2. no id, no change

section("2) no atlas id: the Frame drawing of 38c363a, Frame for Frame");
{
	const golden = JSON.parse(readFileSync(GOLDEN, "utf8")).digests;
	for (const [name, want] of Object.entries(golden)) {
		const got = flat[name];
		check(
			got !== undefined && got.sha1 === want.sha1 && got.steps === want.steps,
			`${name.padEnd(10)} ${want.steps} draws: every Frame's position, size, colour, layer and visibility as before`,
			got?.sha1,
		);
	}
	const built = measure(() => viewAt(48, Icon.maxItemFrames()));
	check(
		built.created === Icon.maxItemFrames() + 1 && built.log.every(e => e.inst.ClassName === "Frame"),
		`a reserved view still builds its ${Icon.maxItemFrames()} Frames up front, and no ImageLabel`,
		`${built.created} Instances`,
	);
}

// ================================================================ 3. with an id

section("3) with an atlas id: one ImageLabel per icon, the same picture on the same square");

/** what is wrong with a view that should show `key` from the atlas (an empty list: nothing) */
function atlasProblems(view, key, dim, ink) {
	const kids = view.frame.GetChildren();
	const img = kids.find(k => k.ClassName === "ImageLabel");
	const cell = ICON_ATLAS_CELLS[key];
	const mono = GLYPH_KEYS.includes(key);
	const out = [];
	if (kids.length !== 1 || img === undefined) out.push(`${kids.length} children`);
	if (img === undefined) return out;
	if (!img.Visible) out.push("hidden");
	if (img.Image !== FAKE) out.push("id");
	const [ox, oy] = dim && !mono ? [cell[3], cell[4]] : [cell[0], cell[1]];
	if (img.ImageRectOffset?.X !== ox || img.ImageRectOffset?.Y !== oy) out.push("offset");
	if (img.ImageRectSize?.X !== cell[2] || img.ImageRectSize?.Y !== cell[2]) out.push("size");
	if (img.ResampleMode?.Name !== "Pixelated" || img.ScaleType?.Name !== "Stretch") out.push("resample");
	const tint = mono ? ink : WHITE;
	if (img.ImageColor3.R !== tint.R || img.ImageColor3.G !== tint.G || img.ImageColor3.B !== tint.B) out.push("tint");
	if (img.ImageTransparency !== 0 || img.BackgroundTransparency !== 1) out.push("transparency");
	if (view.frame.GetAttribute("Icon") !== key) out.push("attribute");
	return out;
}

/** mismatched pixels between two rasters, and how many have no pixel of their colour within 1 px in the other */
function compare(a, b, w, h) {
	let diff = 0;
	let far = 0;
	const near = (src, dst, x, y) => {
		const want = src.readUInt32BE((y * w + x) * 4);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const X = x + dx;
				const Y = y + dy;
				if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
				if (dst.readUInt32BE((Y * w + X) * 4) === want) return true;
			}
		}
		return false;
	};
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const o = (y * w + x) * 4;
			if (a.readUInt32BE(o) === b.readUInt32BE(o)) continue;
			diff++;
			if (!near(a, b, x, y) || !near(b, a, x, y)) far++;
		}
	}
	return { diff, far };
}

const rasterReport = [];
{
	const INKS = [THEME.foreground, GAME.success];
	const cases = [
		...ICON_KEYS.map(k => [k, false, undefined]),
		...ICON_KEYS.map(k => [k, true, undefined]),
		...INKS.flatMap(ink => GLYPH_KEYS.map(k => [k, false, ink])),
	];
	for (const size of SIZES) {
		setAtlas("");
		const flatView = viewAt(size);
		setAtlas(FAKE);
		const view = viewAt(size);
		const bad = [];
		let exact = 0;
		let pixels = 0;
		let diff = 0;
		let far = 0;
		for (const [k, dim, ink] of cases) {
			Icon.drawIcon(view, k, { dim, ink });
			Icon.drawIcon(flatView, k, { dim, ink });
			const p = atlasProblems(view, k, dim, ink);
			if (p.length > 0) bad.push(`${k}: ${p.join(" ")}`);
			const img = view.frame.GetChildren()[0];
			if (size === 0) {
				const whole =
					img.Position.X.Scale === 0 &&
					img.Position.X.Offset === 0 &&
					img.Position.Y.Offset === 0 &&
					img.Size.X.Scale === 1 &&
					img.Size.Y.Scale === 1;
				if (!whole) bad.push(`${k}: not the whole view in Scale`);
				continue;
			}
			const w = size + 8;
			const a = rasterFrames(flatView, w, w);
			const b = rasterImage(view, w, w);
			const n = GLYPH_KEYS.includes(k) ? 8 : 16;
			const whole = flatView.px % n === 0;
			const c = compare(a, b, w, w);
			pixels += w * w;
			diff += c.diff;
			far += c.far;
			if (whole && c.diff > 0) bad.push(`${k}${dim ? "@dim" : ""}: ${c.diff} px differ at ${flatView.px} px`);
			if (whole) exact++;
		}
		const label = size === 0 ? "Scale (size not known yet)" : `${size} px`;
		check(
			bad.length === 0,
			`${label.padEnd(26)} ${cases.length} draws: one visible ImageLabel each, its cell, Pixelated, the right tint${size > 0 ? `; pixel-identical in the ${exact} whose texels are whole pixels` : ""}`,
			bad.slice(0, 4).join("; "),
		);
		if (size > 0) {
			check(
				far === 0,
				`${label.padEnd(26)} elsewhere every differing pixel is a texel edge moved by 1 px (${diff} of ${pixels} px)`,
				`${far} farther`,
			);
			rasterReport.push(`${label}: ${diff} of ${pixels} px differ (${((100 * diff) / pixels).toFixed(2)} %)`);
		}
		view.frame.Destroy();
		flatView.frame.Destroy();
	}
	let built;
	const reserved = measure(() => {
		built = viewAt(48, Icon.maxItemFrames());
	});
	check(
		reserved.created === 2 && reserved.log.some(e => e.inst.ClassName === "ImageLabel"),
		`a view built to hold any item (reserve ${Icon.maxItemFrames()}) is the square and ONE ImageLabel`,
		`${reserved.created} Instances, against ${Icon.maxItemFrames() + 1} with no id`,
	);
	built.frame.Destroy();
}

// ================================================================ 4. no churn

section("4) no churn: repaints, clears and resizes create nothing and write only what changed");
{
	const views = [viewAt(48), viewAt(44, Icon.maxItemFrames()), viewAt(0)];
	const glyph = viewAt(20);
	Icon.drawIcon(views[0], ICON_KEYS[0]);
	const cycle = measure(() => {
		for (let i = 0; i < 400; i++) {
			for (const v of views) {
				const k = ICON_KEYS[(i * 7) % ICON_KEYS.length];
				if (i % 50 === 49) Icon.clearIcon(v);
				else Icon.drawIcon(v, k, { dim: i % 3 === 0 });
			}
			const ink = i % 2 === 0 ? THEME.foreground : GAME.success;
			Icon.drawIcon(glyph, GLYPH_KEYS[i % GLYPH_KEYS.length], { ink });
			if (i % 100 === 0) {
				views[0].frame.AbsoluteSize = new Vector2(40 + (i % 3) * 8, 40 + (i % 3) * 8);
				flush();
			}
		}
	});
	check(
		cycle.created === 0 && cycle.destroyed === 0,
		"1,600 repaints, clears and four resizes create and destroy no Instance",
		`${cycle.created} created, ${cycle.destroyed} destroyed, ${cycle.writes} writes`,
	);
	const v = views[0];
	Icon.drawIcon(v, "dagger");
	const same = measure(() => {
		for (let i = 0; i < 60; i++) Icon.drawIcon(v, "dagger");
	});
	check(same.writes === 0, "the same icon again writes nothing", `${same.writes} writes`);
	const other = measure(() => Icon.drawIcon(v, "axe"));
	const img = v.frame.GetChildren()[0];
	check(
		other.writes === 1,
		"another icon of the same size writes only its ImageRectOffset",
		`${other.writes} writes`,
	);
	const first = img.ImageRectOffset;
	Icon.drawIcon(v, "pistol");
	Icon.drawIcon(v, "axe");
	Icon.drawIcon(views[2], "axe");
	check(
		img.ImageRectOffset === first && views[2].frame.GetChildren()[0].ImageRectOffset === first,
		"the rect Vector2s are made once per cell and shared by every view (a paint allocates none)",
	);
	for (const x of [...views, glyph]) x.frame.Destroy();
}

// ================================================================ 5. the fallback

section("5) the atlas does not load: every live view repaints as its Frame drawing");
{
	setAtlas(FAKE);
	const cases = [
		[48, 0, "dagger", { dim: false }],
		[44, Icon.maxItemFrames(), "pistol", { dim: true }],
		[20, 0, "check", { ink: GAME.success }],
		[0, 0, "cat_blade", {}],
	];
	const live = cases.map(([size, reserve, key, opts]) => {
		const v = viewAt(size, reserve);
		Icon.drawIcon(v, key, opts);
		return v;
	});
	const idle = viewAt(48);
	const swap = measure(() => setAtlas("rbxassetid://910000002"));
	check(
		swap.created === 0 && live.every(v => v.frame.GetChildren()[0].Image === "rbxassetid://910000002"),
		"a new id reaches every live view in place",
	);
	const lost = measure(() => setAtlas(""));
	const want = cases.map(([size, reserve, key, opts]) => {
		const v = viewAt(size, reserve);
		Icon.drawIcon(v, key, opts);
		return snap(v);
	});
	check(
		live.every((v, i) => snap(v) === want[i]),
		"each one is then exactly the view that never had the atlas: same Frames, same colours, its reserve built",
		live.map((v, i) => (snap(v) === want[i] ? "=" : cases[i][2])).join(" "),
	);
	check(
		lost.destroyed === cases.length + 1 && idle.frame.GetChildren().length === 0,
		"the ImageLabels go (one per view, the empty one too); an empty view waits for its first icon",
		`${lost.created} created, ${lost.destroyed} destroyed`,
	);
	const after = measure(() => viewAt(48, Icon.maxItemFrames()));
	check(
		after.created === Icon.maxItemFrames() + 1,
		"a view built afterwards reserves its Frames again",
		`${after.created} Instances`,
	);
	WA.overrideWorldArt(undefined);
}

// ================================================================ 6. fit "drawn"

section('6) fit "drawn": what is drawn sits in the middle of the square, the same pixels moved by whole pixels');
{
	/** a view `size` px square (0: the Scale path) with fit `fit` */
	const viewFit = (size, fit, reserve = 0) => {
		const v = Icon.IconView(root, "ItemIcon", 0, 0, 48, 1, reserve, fit);
		if (size > 0) v.frame.AbsoluteSize = new Vector2(size, size);
		flush();
		return v;
	};
	/** the box of a raster's painted pixels, [x0, y0, x1, y1) */
	const boxOf = (px, w, h) => {
		const b = [Infinity, Infinity, -Infinity, -Infinity];
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				if (px[(y * w + x) * 4 + 3] === 0) continue;
				b[0] = Math.min(b[0], x);
				b[1] = Math.min(b[1], y);
				b[2] = Math.max(b[2], x + 1);
				b[3] = Math.max(b[3], y + 1);
			}
		}
		return b;
	};
	/** `px` (w x h) moved by (dx, dy) */
	const moved = (px, w, h, dx, dy) => {
		const out = Buffer.alloc(w * h * 4);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const X = x + dx;
				const Y = y + dy;
				if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
				px.copy(out, (Y * w + X) * 4, (y * w + x) * 4, (y * w + x) * 4 + 4);
			}
		}
		return out;
	};
	const SIZES_DRAWN = [48, 44, 40, 32, 24, 20, 16];
	const KEYS = [...ICON_KEYS, ...GLYPH_KEYS];
	for (const atlas of [false, true]) {
		setAtlas(atlas ? FAKE : "");
		const off = [];
		const notSame = [];
		const predicted = [];
		let worst = 0;
		for (const size of SIZES_DRAWN) {
			const cellView = viewFit(size, "cell");
			const view = viewFit(size, "drawn");
			for (const k of KEYS) {
				const ink = GLYPH_KEYS.includes(k) ? THEME.foreground : undefined;
				Icon.drawIcon(cellView, k, { ink });
				Icon.drawIcon(view, k, { ink });
				const w = size + 8;
				const raster = atlas ? rasterImage : rasterFrames;
				const a = raster(view, w, w);
				const b = boxOf(a, w, w);
				// the square the view fills: its side px at (ox, oy) of the frame
				const cx = view.ox + view.px / 2;
				const cy = view.oy + view.px / 2;
				const d = Math.max(Math.abs((b[0] + b[2]) / 2 - cx), Math.abs((b[1] + b[3]) / 2 - cy));
				worst = Math.max(worst, d);
				if (d > (atlas ? 1 : 0.5)) off.push(`${k}@${size}: ${d}`);
				// the same drawing as "cell", moved: the pixels are not redrawn, only placed
				const c = raster(cellView, w, w);
				if (!moved(c, w, w, view.sx, view.sy).equals(a)) notSame.push(`${k}@${size}`);
				if (!atlas) {
					// drawnRects: what a layout is told the view paints (hudConsole.ts fitTileIcon trusts it)
					const runs = view.frame.GetChildren().filter(f => f.ClassName === "Frame" && f.Visible);
					const want = Icon.drawnRects(k, view.px).map(r => r.join(","));
					const got = runs.map(f =>
						[
							f.Position.X.Offset - view.ox,
							f.Position.Y.Offset - view.oy,
							f.Position.X.Offset - view.ox + f.Size.X.Offset,
							f.Position.Y.Offset - view.oy + f.Size.Y.Offset,
						].join(","),
					);
					if (want.join(";") !== got.join(";")) predicted.push(`${k}@${size}`);
				}
			}
			cellView.frame.Destroy();
			view.frame.Destroy();
		}
		const path = atlas ? "atlas" : "Frames";
		check(
			off.length === 0,
			`${path}: every one of the ${KEYS.length} icons and glyphs at ${SIZES_DRAWN.join(", ")} px has the centre of what it draws within ${atlas ? "1 px" : "half a pixel"} of the square's (worst ${worst} px)`,
			off.slice(0, 4).join("; "),
		);
		check(
			notSame.length === 0,
			`${path}: ...and it is the "cell" drawing pixel for pixel, moved by whole pixels`,
			notSame.slice(0, 4).join(", "),
		);
		if (!atlas) {
			check(
				predicted.length === 0,
				"drawnRects(key, side) is exactly the runs the view places (the hotbar's layout can trust it)",
				predicted.slice(0, 4).join(", "),
			);
		}
	}
	// before the view knows its size: the same shift in Scale, for the runs and for the image
	setAtlas("");
	const scaled = viewFit(0, "drawn");
	Icon.drawIcon(scaled, "dagger");
	const [bx0, by0, bx1, by1] = Icon.drawnBox("dagger");
	const fx = (16 - bx0 - bx1) / 32;
	const fy = (16 - by0 - by1) / 32;
	const r0 = Icon.iconRuns("dagger")[0];
	const f0 = scaled.frame.GetChildren().find(f => f.Visible);
	check(
		Math.abs(f0.Position.X.Scale - (r0[0] / 16 + fx)) < 1e-9 &&
			Math.abs(f0.Position.Y.Scale - (r0[1] / 16 + fy)) < 1e-9,
		"in Scale (the size not known yet) the runs carry the same centring, as a share of the square",
		`dagger's box [${bx0}, ${by0}, ${bx1}, ${by1}) -> ${fx}, ${fy}`,
	);
	scaled.frame.Destroy();
	setAtlas(FAKE);
	const scaledImg = viewFit(0, "drawn");
	Icon.drawIcon(scaledImg, "dagger");
	const img = scaledImg.frame.GetChildren()[0];
	check(
		Math.abs(img.Position.X.Scale - fx) < 1e-9 &&
			Math.abs(img.Position.Y.Scale - fy) < 1e-9 &&
			img.Size.X.Scale === 1,
		"...and so does the atlas image",
	);
	scaledImg.frame.Destroy();
	// no churn: a pooled "drawn" view repaints and resizes in place
	for (const atlas of [false, true]) {
		setAtlas(atlas ? FAKE : "");
		const v = viewFit(48, "drawn", Icon.maxItemFrames());
		const cycle = measure(() => {
			for (let i = 0; i < 300; i++) {
				Icon.drawIcon(v, ICON_KEYS[(i * 5) % ICON_KEYS.length], { dim: i % 4 === 0 });
				if (i % 60 === 0) {
					v.frame.AbsoluteSize = new Vector2(24 + (i % 3) * 16, 24 + (i % 3) * 16);
					flush();
				}
			}
		});
		Icon.drawIcon(v, "axe");
		const again = measure(() => Icon.drawIcon(v, "axe"));
		check(
			cycle.created === 0 && cycle.destroyed === 0 && again.writes === 0,
			`${atlas ? "atlas" : "Frames"}: 300 repaints and resizes of a "drawn" view create nothing; the same icon again writes nothing`,
			`${cycle.created} created, ${cycle.writes} writes; again ${again.writes}`,
		);
		v.frame.Destroy();
	}
	setAtlas("");
}

// ================================================================ the pictures (--render <dir>)

/**
 * Every icon, dimmed icon and inked glyph on the Bag's tile iron, at 48 px and at a phone's 44 px: `before.png` drawn
 * by the Frames, `after.png` by the atlas (the review images of docs/art/icons).
 */
function renderSheets(dir) {
	const COLS = 16;
	const PAD = 8;
	const cases = [
		...ICON_KEYS.map(k => [k, false, undefined]),
		...ICON_KEYS.map(k => [k, true, undefined]),
		...GLYPH_KEYS.map(k => [k, false, THEME.foreground]),
	];
	const rowsOf = n => Math.ceil(n / COLS);
	const blocks = [48, 44];
	const W = COLS * (blocks[0] + PAD) + PAD;
	const H = blocks.reduce((s, size) => s + (rowsOf(ICON_KEYS.length) * 2 + 1) * (size + PAD) + PAD * 3, PAD);
	const bg = [0x2a, 0x2c, 0x33];
	for (const [file, atlas] of [
		["before.png", ""],
		["after.png", FAKE],
	]) {
		const data = Buffer.alloc(W * H * 4);
		for (let i = 0; i < W * H; i++) data.set([...bg, 255], i * 4);
		let y0 = PAD;
		for (const size of blocks) {
			setAtlas(atlas);
			const view = viewAt(size);
			let row = 0;
			let col = 0;
			let group = "";
			for (const [k, dim, ink] of cases) {
				const g = ink !== undefined ? "glyph" : dim ? "dim" : "icon";
				if (g !== group && group !== "") {
					row += col > 0 ? 1 : 0;
					col = 0;
					y0 += PAD;
				}
				group = g;
				Icon.drawIcon(view, k, { dim, ink });
				const px = atlas === "" ? rasterFrames(view, size, size) : rasterImage(view, size, size);
				const x0 = PAD + col * (size + PAD);
				const yy = y0 + row * (size + PAD);
				for (let y = 0; y < size; y++) {
					for (let x = 0; x < size; x++) {
						const s = (y * size + x) * 4;
						if (px[s + 3] === 0) continue;
						px.copy(data, ((yy + y) * W + x0 + x) * 4, s, s + 4);
					}
				}
				col++;
				if (col === COLS) {
					col = 0;
					row++;
				}
			}
			y0 += (row + (col > 0 ? 1 : 0)) * (size + PAD) + PAD * 2;
			view.frame.Destroy();
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, file), encodePNG({ w: W, h: H, data }, true));
		console.log(`  wrote ${join(dir, file)} (${W} x ${H})`);
	}
	setAtlas("");
}

const renderAt = process.argv.indexOf("--render");
if (renderAt >= 0) {
	section("the pictures");
	renderSheets(process.argv[renderAt + 1] ?? join(ROOT, "docs", "art", "icons"));
}
WA.overrideWorldArt(undefined);

// ================================================================ report

section("what an icon costs");
{
	const counts = ICON_KEYS.map(k => Icon.iconFrameCount(k));
	const total = counts.reduce((a, b) => a + b, 0);
	console.log(
		`  Frames: ${(total / counts.length).toFixed(1)} per icon on average, ${Math.max(...counts)} at most (${ICON_KEYS.length} icons); with the atlas: 1 ImageLabel`,
	);
	const cells = Object.keys(entry.cells).length + Object.keys(entry.dim).length;
	console.log(`  atlas: ${entry.w} x ${entry.h} texels, ${cells} cells, ${(png.length / 1024).toFixed(1)} kB`);
	for (const line of rasterReport) console.log(`  raster against the Frames, ${line}`);
}

console.log(failures === 0 ? "\nitem icons: all checks pass" : `\nitem icons: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
