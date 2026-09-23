#!/usr/bin/env node
/*
 * Project Z UI skin: generates the 9-slice textures of the "Pixel Quest relief" kit into design/ui-skin/.
 *
 * Every texture is GREYSCALE + ALPHA: the game tints it with ImageColor3 (an exact theme token), so the
 * colour audit of the instances keeps seeing tokens only. White (255) = the tint at full strength, a darker
 * grey = a darker shade of the tint, alpha < 255 = a wash of the tint over whatever is below.
 *
 * Pixel grid: every texture is authored at 1 texel = 1 "skin pixel" and then upscaled by UNIT (nearest
 * neighbour), so the uploaded asset is a normal-sized image while the artwork stays pixel perfect. The game
 * draws it with ScaleType.Slice + SliceScale = skinPx / UNIT and ResamplerMode.Pixelated, which keeps every
 * skin pixel an exact integer block of screen pixels.
 *
 *   node tools/gen-ui-skin.mjs            # writes design/ui-skin/*.png + manifest.json
 *   node tools/gen-ui-skin.mjs --assets   # + rewrites src/client/ui/skinAssets.ts from assets.json
 *
 * Shapes use "bitten" corners (1-2 px cut) instead of rounded corners, the way the reference art does.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "design", "ui-skin");
/** upscale factor of the authored pixel grid (the game divides SliceScale by it) */
const UNIT = 4;

// ---------------------------------------------------------------- PNG encoder (from tools/gen-sprites.mjs)

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "latin1");
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(canvas) {
	const { w, h, data } = canvas;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const stride = w * 4;
	const raw = Buffer.alloc((stride + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (stride + 1)] = 0; // filter: None
		data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
	}
	const idat = deflateSync(raw, { level: 9 });
	return Buffer.concat([PNG_MAGIC, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- pixel grid helpers

/** grey + alpha grid, authored at 1 texel per skin pixel */
function grid(w, h) {
	return { w, h, px: new Array(w * h).fill(null) };
}

function put(g, x, y, grey, alpha) {
	if (x < 0 || y < 0 || x >= g.w || y >= g.h) return;
	g.px[y * g.w + x] = [grey, alpha];
}

function at(g, x, y) {
	if (x < 0 || y < 0 || x >= g.w || y >= g.h) return null;
	return g.px[y * g.w + x];
}

/** rectangle with "bitten" pixel corners: a corner pixel is cut when its two distances add up to less than `bite` */
function biteMask(w, h, bite, biteTop = bite, biteBottom = bite) {
	const mask = new Array(w * h).fill(false);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const dx0 = x;
			const dx1 = w - 1 - x;
			const dy0 = y;
			const dy1 = h - 1 - y;
			const cut =
				dx0 + dy0 < biteTop || dx1 + dy0 < biteTop || dx0 + dy1 < biteBottom || dx1 + dy1 < biteBottom;
			mask[y * w + x] = !cut;
		}
	}
	return mask;
}

const inMask = (mask, w, h, x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];

/** pixels of the mask that touch the outside (4-neighbourhood): the 1 px outline of the shape */
function edgeOf(mask, w, h) {
	const out = new Array(w * h).fill(false);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!mask[y * w + x]) continue;
			if (
				!inMask(mask, w, h, x - 1, y) ||
				!inMask(mask, w, h, x + 1, y) ||
				!inMask(mask, w, h, x, y - 1) ||
				!inMask(mask, w, h, x, y + 1)
			) {
				out[y * w + x] = true;
			}
		}
	}
	return out;
}

/** mask minus its outline (one erosion step) */
function erode(mask, w, h) {
	const edge = edgeOf(mask, w, h);
	return mask.map((v, i) => v && !edge[i]);
}

/** the k-th 1 px ring of the shape, counting from the outside (1 = outline) */
function ring(mask, w, h, k) {
	let cur = mask;
	for (let i = 1; i < k; i++) cur = erode(cur, w, h);
	return edgeOf(cur, w, h);
}

/** paints `mask` pixels into the grid */
function paint(g, mask, grey, alpha) {
	for (let y = 0; y < g.h; y++) {
		for (let x = 0; x < g.w; x++) {
			if (mask[y * g.w + x]) put(g, x, y, grey, alpha);
		}
	}
}

/** upscales the authored grid by UNIT and encodes it as RGBA PNG */
function toPNG(g) {
	const w = g.w * UNIT;
	const h = g.h * UNIT;
	const data = Buffer.alloc(w * h * 4);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const p = at(g, Math.floor(x / UNIT), Math.floor(y / UNIT));
			const i = (y * w + x) * 4;
			if (p === null) continue;
			data[i] = p[0];
			data[i + 1] = p[0];
			data[i + 2] = p[0];
			data[i + 3] = p[1];
		}
	}
	return encodePNG({ w, h, data });
}

// ---------------------------------------------------------------- the skin

/** relief metrics, in skin pixels (1 skin px = 1..3 screen px, see skin.ts) */
const BTN_W = 8;
const BTN_H = 10;
const BTN_SLICE = [3, 3, 5, 5]; // left, top, right(=w-3), bottom(=h-5)
const LIP = 3; // dark "base" under a raised face
const PRESS = 2; // how far the face drops when pressed
const BITE = 2;

const A = {
	edge: 222, // dark outline of a raised face
	lip: 130, // the base under it
	hl: 78, // top highlight, idle
	hlHot: 148, // top highlight, hover / focus
	rim: 58, // inner rim, hover / focus
	innerShadow: 105, // pressed: shadow under the top edge
	panelEdge: 235,
};

const textures = [];

function texture(name, description, g, slice) {
	const file = `${name}.png`;
	writeFileSync(join(OUT_DIR, file), toPNG(g));
	textures.push({
		name,
		file,
		description,
		width: g.w * UNIT,
		height: g.h * UNIT,
		unit: UNIT,
		/** SliceCenter in image pixels: [x0, y0, x1, y1] */
		sliceCenter: slice.map(v => v * UNIT),
		/** the same, in authored skin pixels */
		sliceSkin: slice,
	});
}

// ---- raised button: face (tint = the variant colour), shade (tint = background), light (tint = foreground)

function buttonFace(pressed) {
	const g = grid(BTN_W, BTN_H);
	const h = pressed ? BTN_H - PRESS : BTN_H;
	const mask = biteMask(BTN_W, h, BITE);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < BTN_W; x++) {
			if (mask[y * BTN_W + x]) put(g, x, y, 255, 255);
		}
	}
	return g;
}

function buttonShade(pressed) {
	const g = grid(BTN_W, BTN_H);
	const h = pressed ? BTN_H - PRESS : BTN_H;
	const mask = biteMask(BTN_W, h, BITE);
	const edge = edgeOf(mask, BTN_W, h);
	const lip = pressed ? LIP - PRESS : LIP;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < BTN_W; x++) {
			const i = y * BTN_W + x;
			if (!mask[i]) continue;
			if (edge[i]) put(g, x, y, 0, A.edge);
			else if (y >= h - 1 - lip && y <= h - 2) put(g, x, y, 0, A.lip);
			else if (pressed && y === 1) put(g, x, y, 0, A.innerShadow);
		}
	}
	return g;
}

function buttonLight(hot) {
	const g = grid(BTN_W, BTN_H);
	const mask = biteMask(BTN_W, BTN_H, BITE);
	const edge = edgeOf(mask, BTN_W, BTN_H);
	const band = hot ? A.hlHot : A.hl;
	for (let y = 0; y < BTN_H; y++) {
		for (let x = 0; x < BTN_W; x++) {
			const i = y * BTN_W + x;
			if (!mask[i] || edge[i]) continue;
			const lipTop = BTN_H - 1 - LIP;
			if (y === 1 || y === 2) put(g, x, y, 255, band);
			else if (hot && y < lipTop) {
				// inner rim on the sides and just above the base
				const side = !inMask(mask, BTN_W, BTN_H, x - 1, y) || !inMask(mask, BTN_W, BTN_H, x + 1, y);
				const nearEdge = side || edge[i - 1] || edge[i + 1] || y === lipTop - 1;
				if (nearEdge) put(g, x, y, 255, A.rim);
			}
		}
	}
	return g;
}

// ---- panel: fill + thick frame + dark outer edge (the "moldura grossa" of the reference)

const PANEL_W = 12;
const PANEL_H = 12;
const PANEL_SLICE = [5, 5, 7, 7];

function panelLayer(kind) {
	const g = grid(PANEL_W, PANEL_H);
	const mask = biteMask(PANEL_W, PANEL_H, BITE);
	if (kind === "fill") {
		paint(g, mask, 255, 255);
		return g;
	}
	if (kind === "edge") {
		paint(g, ring(mask, PANEL_W, PANEL_H, 1), 0, A.panelEdge);
		return g;
	}
	// frame: 3 px ring inside the dark edge, with a slightly lighter top row (light from above)
	for (let k = 2; k <= 4; k++) paint(g, ring(mask, PANEL_W, PANEL_H, k), 255, 255);
	return g;
}

// ---- title strip: a band of the frame colour with a dark line under it

const STRIP_W = 6;
const STRIP_H = 6;
const STRIP_SLICE = [2, 2, 4, 4];

function stripTexture() {
	const g = grid(STRIP_W, STRIP_H);
	const mask = biteMask(STRIP_W, STRIP_H, 1, 1, 0); // only the top corners are bitten
	for (let y = 0; y < STRIP_H; y++) {
		for (let x = 0; x < STRIP_W; x++) {
			if (!mask[y * STRIP_W + x]) continue;
			if (y === STRIP_H - 1) put(g, x, y, 62, 255); // dark rule under the strip
			else if (y === 0) put(g, x, y, 255, 255);
			else put(g, x, y, 255, 255);
		}
	}
	return g;
}

// ---- well (recessed content, list rows, tracks, chips): fill + 1 px border

const WELL_W = 6;
const WELL_H = 6;
const WELL_SLICE = [2, 2, 4, 4];

function wellLayer(kind) {
	const g = grid(WELL_W, WELL_H);
	const mask = biteMask(WELL_W, WELL_H, 1);
	if (kind === "fill") {
		paint(g, mask, 255, 255);
		return g;
	}
	paint(g, ring(mask, WELL_W, WELL_H, 1), 255, 255);
	return g;
}

// ---- gamepad focus ring (drawn outside the control)

const FOCUS_W = 10;
const FOCUS_H = 10;
const FOCUS_SLICE = [4, 4, 6, 6];

function focusTexture() {
	const g = grid(FOCUS_W, FOCUS_H);
	const mask = biteMask(FOCUS_W, FOCUS_H, BITE);
	paint(g, ring(mask, FOCUS_W, FOCUS_H, 1), 255, 255);
	paint(g, ring(mask, FOCUS_W, FOCUS_H, 2), 255, 255);
	return g;
}

// ---------------------------------------------------------------- write everything

mkdirSync(OUT_DIR, { recursive: true });

texture("btnFace", "raised face (tint: the variant colour)", buttonFace(false), BTN_SLICE);
texture("btnShade", "raised outline + bottom base/lip (tint: background)", buttonShade(false), BTN_SLICE);
texture("btnLight", "top highlight, idle (tint: foreground)", buttonLight(false), BTN_SLICE);
texture("btnLightHot", "top highlight + inner rim, hover/focus (tint: foreground)", buttonLight(true), BTN_SLICE);
texture("btnFacePress", "pressed face, dropped 2 px (tint: the variant colour)", buttonFace(true), BTN_SLICE);
texture("btnShadePress", "pressed outline, short lip, inner shadow (tint: background)", buttonShade(true), BTN_SLICE);
texture("panelFill", "panel interior (tint: panel background)", panelLayer("fill"), PANEL_SLICE);
texture("panelFrame", "3 px panel frame (tint: frame colour)", panelLayer("frame"), PANEL_SLICE);
texture("panelEdge", "1 px dark outer edge of a panel (tint: background)", panelLayer("edge"), PANEL_SLICE);
texture("strip", "title strip with its dark rule (tint: frame colour)", stripTexture(), STRIP_SLICE);
texture("wellFill", "recessed fill: wells, rows, tracks, chips (tint: fill colour)", wellLayer("fill"), WELL_SLICE);
texture("wellBorder", "1 px border of a well / chip (tint: border colour)", wellLayer("border"), WELL_SLICE);
texture("focusRing", "2 px gamepad focus ring drawn outside a control (tint: ring)", focusTexture(), FOCUS_SLICE);

const manifest = {
	generator: "tools/gen-ui-skin.mjs",
	style: "Pixel Quest relief: flat fills, thick frames, bitten pixel corners, raised faces with a base",
	unit: UNIT,
	note: "greyscale + alpha; the client tints each layer with ImageColor3 (an exact theme token) and draws it with ScaleType.Slice, SliceScale = skinPx / unit, ResamplerMode.Pixelated",
	parts: {
		button: ["btnFace", "btnShade", "btnLight|btnLightHot"],
		buttonPressed: ["btnFacePress", "btnShadePress"],
		panel: ["panelFill", "panelFrame", "panelEdge"],
		titleStrip: ["strip"],
		well: ["wellFill", "wellBorder"],
		tabActive: ["btnFace", "btnShade", "btnLight"],
		tabInactive: ["wellFill", "wellBorder"],
		chip: ["wellFill", "wellBorder"],
		badge: ["wellFill", "wellBorder"],
		barTrack: ["wellFill", "wellBorder"],
		sliderKnob: ["btnFace", "btnShade", "btnLight"],
		tooltip: ["wellFill", "wellBorder"],
		focus: ["focusRing"],
	},
	textures,
};
writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, undefined, "\t")}\n`);

let total = 0;
for (const t of textures) total += t.width * t.height;
console.log(`ui-skin: ${textures.length} textures in ${OUT_DIR} (${total} px total)`);
for (const t of textures) {
	console.log(`  ${t.name.padEnd(14)} ${`${t.width}x${t.height}`.padEnd(8)} slice ${t.sliceCenter.join(",")}`);
}

// ---------------------------------------------------------------- skinAssets.ts (after the upload)

if (process.argv.includes("--assets")) {
	const assetsPath = join(OUT_DIR, "assets.json");
	if (!existsSync(assetsPath)) {
		console.log(`no ${assetsPath}: upload the textures first`);
		process.exit(1);
	}
	const assets = JSON.parse(readFileSync(assetsPath, "utf8"));
	const ids = assets.ids ?? assets;
	const lines = [];
	lines.push("// generated by tools/gen-ui-skin.mjs --assets — do not edit");
	lines.push("// textures: design/ui-skin/manifest.json (tools/gen-ui-skin.mjs), asset ids: design/ui-skin/assets.json");
	lines.push("// an empty id turns that texture off: the kit then draws the flat fallback (Frames + UIStroke)");
	lines.push("");
	lines.push("export interface SkinTextureAsset {");
	lines.push("\t/** \"rbxassetid://...\", or \"\" when the texture was not uploaded */");
	lines.push("\tid: string;");
	lines.push("\t/** 9-slice edges of the uploaded image (SliceCenter) */");
	lines.push("\tslice: readonly [number, number, number, number];");
	lines.push("}");
	lines.push("");
	lines.push("/** upscale factor of the authored pixel grid: SliceScale = skin pixels / UNIT */");
	lines.push(`export const SKIN_UNIT = ${UNIT};`);
	lines.push("");
	lines.push(`export type SkinTextureName =${textures.map(t => `\n\t| "${t.name}"`).join("")};`);
	lines.push("");
	lines.push("export const SKIN_TEXTURES: Record<SkinTextureName, SkinTextureAsset> = {");
	for (const t of textures) {
		const id = ids[t.name] ?? "";
		lines.push(`\t/** ${t.description} */`);
		lines.push(`\t${t.name}: { id: "${id}", slice: [${t.sliceCenter.join(", ")}] },`);
	}
	lines.push("};");
	lines.push("");
	lines.push("/** every texture of the skin, for the preload pass */");
	// one name per line: the single-line form goes past Prettier's print width and `format:check` fails in CI
	lines.push("export const SKIN_TEXTURE_NAMES: Array<SkinTextureName> = [");
	for (const t of textures) lines.push(`\t"${t.name}",`);
	lines.push("];");
	lines.push("");
	const out = join(ROOT, "src", "client", "ui", "skinAssets.ts");
	writeFileSync(out, lines.join("\n"));
	console.log(`wrote ${out}`);
}
