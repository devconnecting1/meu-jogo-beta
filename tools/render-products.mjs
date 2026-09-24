#!/usr/bin/env node
/*
 * The icons of the Robux costumes (docs/SHOP.md "Os produtos que o dono cria"): one 512 x 512 PNG per COSTUMES entry of
 * shared/data/shop.ts, for its developer product in the Creator Hub (Monetization > Developer Products > Edit > icon),
 * drawn by the game's REAL code.
 *
 *   npm run promo:products                          # docs/promo/products/<costume>.png + docs/promo/previews/products.png
 *   npm run promo:products -- --only eagle,santa    # some of them (the file names, without .png)
 *   npm run promo:products -- --out /tmp/promo      # another folder (products/ and previews/ go under it)
 *
 * What is drawn, and by what:
 *   - the cosmetic is the wardrobe's own tile, client/view/cosmeticPreview.ts `SurvivorPreview` with `subject` "pet" or
 *     "outfit": the same drawPet / drawSurvivor the world and every ally use (MON-04), with the characters' pixel art
 *     of design/world-art (the sheets `npm run cloud -- upload-art` puts in the game: survivorsA / B, weapons, dogs,
 *     birds), on the fake GUI tree of tools/fake-gui.mjs, rasterised by tools/gui-raster.mjs as tools/render-promo.mjs
 *     does. Nothing about the cosmetic is drawn here;
 *   - a pet alone, framed on its own texels (not on the room the widest pet needs, PET_SCENE): the birds in flight with
 *     their wings open, facing the viewer (the shop's pet pack shows its pigeon in flight too, `packPetPicture`: landed
 *     and seen from above a pigeon is a grey oval; the eagle's wings open all the way), and the dogs side on, their
 *     longest and most dog-like of the 32 baked headings (seen from the front a dog is a short blob); an outfit on the
 *     survivor facing the viewer, as its wardrobe tile shows it;
 *   - the pixel art is only ever enlarged by a whole number of screen pixels per texel (a texel is 4 units, ART-02): the
 *     largest that fits the subject in SUBJECT_BOX, the texels on whole pixels (the renderer places every sprite on
 *     one), the subject centred;
 *   - the backdrop is theme tokens only (client/ui/theme.ts), in the style of the game's icon (docs/promo/icon): the
 *     dark page, a light pool behind the subject stepped on the subject's own texel grid, and a thin frame whose colour
 *     is the costume's price tier (TIER_FRAME). No text: Roblox writes the product's name and price beside it.
 *
 * Deterministic: the same checkout gives the same bytes. The previews (not uploaded) show every icon at 150 px, the size
 * of the purchase prompt, and at 50 px.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePNG, encodePNG } from "./png-lite.mjs";
import { rasterise } from "./gui-raster.mjs";
import { drawText, textWidth } from "./pixel-font.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const argOf = (k, d) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const OUT = resolve(argOf("out", join(ROOT, "docs", "promo")));
const ONLY = argOf("only", undefined)?.split(",");

// ---------------------------------------------------------------- the real code

const { installShims } = await import("./luau-shim.mjs");
const { SRC, require } = installShims({ seed: 7331 });
const { installFakeGui } = await import("./fake-gui.mjs");
const gui = installFakeGui();
// theme.ts builds its type scale at load (Enum.FontWeight); the fake tree has no fonts, and nothing here writes text
Enum.FontWeight = Object.fromEntries(
	["Regular", "Medium", "SemiBold", "Bold", "ExtraBold"].map(n => [n, { Name: n, EnumType: "FontWeight" }]),
);

const { THEME, SURFACE, GAME, STAT } = require(join(SRC, "client/ui/theme.ts"));
const { COSTUMES } = require(join(SRC, "shared/data/shop.ts"));
const { OutfitLook, PetLook, outfitLookOfEquip, petLookOfEquip, petFlies } = require(
	join(SRC, "shared/data/cosmetics.ts"),
);
const { SurvivorPreview, PREVIEW_FACING } = require(join(SRC, "client/view/cosmeticPreview.ts"));
const { WORLD_TEXEL } = require(join(SRC, "client/view/worldArtAssets.ts"));
const WA = require(join(SRC, "client/view/worldArt.ts"));

// ---------------------------------------------------------------- the characters' art, from the local PNGs

const ART_DIR = join(ROOT, "design", "world-art");
const LOCAL = "local:";
{
	const manifest = JSON.parse(readFileSync(join(ART_DIR, "manifest.json"), "utf8"));
	const ids = {};
	for (const t of manifest.textures) ids[t.name] = LOCAL + t.name;
	WA.overrideWorldArt(ids);
}
const images = new Map();
function localImage(id) {
	if (images.has(id)) return images.get(id);
	const file = id.startsWith(LOCAL) ? join(ART_DIR, `${id.slice(LOCAL.length)}.png`) : undefined;
	const img = file !== undefined && existsSync(file) ? decodePNG(readFileSync(file)) : undefined;
	if (img === undefined) throw new Error(`render-products: no local art for ${id}`);
	images.set(id, img);
	return img;
}

// ---------------------------------------------------------------- the products

/** the icon's side: the size the Creator Hub asks for (it is shown at 150 px in the purchase prompt) */
const IW = 512;
/** the thin frame round the edge, in the tier's colour (3.5 px at 150) */
const FRAME = 12;
/** the square the subject's texels must fit in, centred: 75% of the icon, so it still fills the prompt's 150 px */
const SUBJECT_BOX = 384;
/** everything drawn (the drop shadow too) stays this far inside the frame */
const INNER_MARGIN = 8;

/**
 * The frame's colour per price tier, from the theme (never a literal), in colours the game already gives a meaning of
 * worth: green, violet, gold from the cheapest up.
 */
const TIER_FRAME = {
	/** the item card's green (STAT.bonus), the green the titles are written in (MON-05) */
	common: STAT.bonus,
	/** "rare items, bosses" (GAME.rare, chart-4's violet) */
	rare: GAME.rare,
	/** the item card's gold (STAT.value), the gold the titles are written in */
	top: STAT.value,
};

/**
 * The tier of each costume, as docs/SHOP.md's table sets it ("Faixa"). A COSTUMES row that carries its own `tier`
 * (shared/data/shop.ts, with the Robux prices) is read from there instead; this table only covers a checkout without.
 */
const TIER_OF = {
	Pigeon: "common",
	"White pigeon": "common",
	Carolina: "common",
	Malamute: "rare",
	Doberman: "rare",
	Santa: "rare",
	Cowboy: "rare",
	Eagle: "top",
	Zombie: "top",
};

/** "White pigeon" -> "white-pigeon": the file name */
const kebab = name =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/** every costume: what it draws (an outfit on the survivor, or a pet alone), its tier and its file */
function products() {
	return COSTUMES.map(c => {
		const outfit = outfitLookOfEquip(c.equipId);
		const pet = petLookOfEquip(c.equipId);
		if (outfit === OutfitLook.None && pet === PetLook.None) {
			throw new Error(`render-products: costume "${c.name}" is neither an outfit nor a pet (cosmetics.ts)`);
		}
		const tier = c.tier ?? TIER_OF[c.name];
		if (TIER_FRAME[tier] === undefined) {
			throw new Error(
				`render-products: costume "${c.name}" has no tier (common, rare or top): add it to TIER_OF`,
			);
		}
		const subject = outfit !== OutfitLook.None ? "outfit" : "pet";
		return { costume: c, subject, look: subject === "outfit" ? outfit : pet, tier, file: kebab(c.name) };
	});
}

/**
 * How a pet poses: a bird in flight (lifted, wings open, as the shop's pet pictures fly it) facing the viewer; a dog
 * standing side on, facing right (towards the product's name in the prompt).
 */
function petPose(look) {
	return petFlies(look) ? { inFlight: true, facing: PREVIEW_FACING } : { inFlight: false, facing: 0 };
}

// ---------------------------------------------------------------- one cosmetic, drawn by the wardrobe's tile

/**
 * The wardrobe's tile for `p` in an IW x IW box, at `zoom` (screen px per world unit), its camera on (camX, camY).
 * The tile frames the scene it is given at the scale asked for (cosmeticPreview.ts previewFit), so a scene a touch
 * smaller than the box puts the camera exactly there at exactly that zoom.
 */
function drawTile(p, zoom, camX, camY) {
	const root = gui.make("Frame");
	root.Size = UDim2.fromOffset(IW, IW);
	const half = (IW / 2 - 4) / zoom;
	const pose = p.subject === "pet" ? petPose(p.look) : undefined;
	const tile = new SurvivorPreview(root, {
		w: IW,
		h: IW,
		subject: p.subject,
		scale: zoom,
		scene: { minX: camX - half, maxX: camX + half, minY: camY - half, maxY: camY + half },
		petInFlight: pose?.inFlight === true,
	});
	if (tile.scale !== zoom) throw new Error(`render-products: the tile drew at ${tile.scale}, not ${zoom}`);
	if (p.subject === "pet") {
		tile.setPet(p.look);
		// the tile always faces its pet towards the viewer; a dog here stands side on (petPose). Its follower is the
		// one piece of the tile the drawing reads the heading from
		if (tile.pet === undefined || typeof tile.pet.angle !== "number") {
			throw new Error("render-products: SurvivorPreview no longer keeps its pet's follower in `pet`");
		}
		tile.pet.angle = pose.facing;
	} else {
		tile.setOutfit(p.look);
	}
	tile.draw(0);
	const layer = tile.frame.FindFirstChild("Sprites");
	if (layer === undefined) throw new Error("render-products: the tile's renderer layer is not called Sprites");
	return { tile, layer };
}

/** a box { x0, y0, x1, y1 } grown to hold another */
const grow = (b, x0, y0, x1, y1) =>
	b === undefined
		? { x0, y0, x1, y1 }
		: { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, y0), x1: Math.max(b.x1, x1), y1: Math.max(b.y1, y1) };

/** the opaque texels of a cell of a sheet: [tx0, ty0, tx1, ty1) inside the rect, or undefined when it is empty */
function opaqueTexels(img, rx, ry, rw, rh) {
	let b;
	for (let y = 0; y < rh; y++) {
		for (let x = 0; x < rw; x++) {
			if (img.data[((ry + y) * img.w + rx + x) * 4 + 3] > 0) b = grow(b, x, y, x + 1, y + 1);
		}
	}
	return b;
}

/**
 * What a drawn tile covers on screen, in px: `art`, the pixel art's opaque texels (the cosmetic itself), with the
 * size of one texel; `all`, everything visible (the drop shadow too).
 */
function measure(layer) {
	let art;
	let all;
	let texel;
	for (const f of layer.GetChildren()) {
		if (f.Visible === false) continue;
		const sx = f.Size.X.Offset;
		const sy = f.Size.Y.Offset;
		const cx = f.Position.X.Offset + (0.5 - f.AnchorPoint.X) * sx;
		const cy = f.Position.Y.Offset + (0.5 - f.AnchorPoint.Y) * sy;
		const label = f.GetChildren().find(k => k.ClassName === "ImageLabel" && k.Visible !== false && k.Image !== "");
		if (label !== undefined) {
			if (Math.abs(f.Rotation) > 0.05) throw new Error("render-products: a pixel-art cell is drawn turned");
			const img = localImage(label.Image);
			const rs = label.ImageRectSize;
			const ro = label.ImageRectOffset;
			const rw = rs.X > 0 ? rs.X : img.w;
			const rh = rs.Y > 0 ? rs.Y : img.h;
			const t = opaqueTexels(img, rs.X > 0 ? ro.X : 0, rs.Y > 0 ? ro.Y : 0, rw, rh);
			if (t === undefined) continue;
			const tp = sx / rw;
			if (texel !== undefined && Math.abs(texel - tp) > 1e-9) throw new Error("render-products: two texel sizes");
			texel = tp;
			const l = cx - sx / 2;
			const top = cy - sy / 2;
			art = grow(art, l + t.x0 * tp, top + t.y0 * tp, l + t.x1 * tp, top + t.y1 * tp);
			all = grow(all, l + t.x0 * tp, top + t.y0 * tp, l + t.x1 * tp, top + t.y1 * tp);
			continue;
		}
		const stroke = f.GetChildren().find(k => k.ClassName === "UIStroke" && k.Enabled);
		const seen = f.BackgroundTransparency < 1 || (stroke !== undefined && stroke.Transparency < 1);
		if (!seen) continue;
		const rot = (f.Rotation * Math.PI) / 180;
		const t = stroke !== undefined ? stroke.Thickness : 0;
		const ex = (Math.abs(Math.cos(rot)) * sx + Math.abs(Math.sin(rot)) * sy) / 2 + t;
		const ey = (Math.abs(Math.sin(rot)) * sx + Math.abs(Math.cos(rot)) * sy) / 2 + t;
		all = grow(all, cx - ex, cy - ey, cx + ex, cy + ey);
	}
	if (art === undefined) throw new Error("render-products: no pixel art drawn (are the characters' sheets live?)");
	return { art, all, texel };
}

/**
 * The cosmetic of `p`, as big as it fits: the largest whole number of px per texel whose art fits SUBJECT_BOX and
 * whose shadow stays inside the frame, the art centred with its texels on whole pixels. Returns the drawn tile's
 * layer, the art's box on screen and the px per texel.
 */
function drawSubject(p) {
	// at 1 px per unit (4 px a texel) everything fits the box: count the art's texels
	const first = drawTile(p, 1, 0, 0);
	const m1 = measure(first.layer);
	first.tile.destroy();
	const artW = (m1.art.x1 - m1.art.x0) / m1.texel;
	const artH = (m1.art.y1 - m1.art.y0) / m1.texel;
	// the art's centre in world units (the tile's camera was on 0, 0 at zoom 1)
	const wx = (m1.art.x0 + m1.art.x1) / 2 - IW / 2;
	const wy = (m1.art.y0 + m1.art.y1) / 2 - IW / 2;
	for (let n = Math.floor(Math.min(SUBJECT_BOX / artW, SUBJECT_BOX / artH)); n >= 1; n--) {
		const zoom = n / WORLD_TEXEL;
		let camX = wx;
		let camY = wy;
		let drawn;
		let m;
		// the renderer puts every sprite on whole pixels; nudge the camera until the art's box is centred to the pixel
		for (let pass = 0; pass < 3; pass++) {
			drawn?.tile.destroy();
			drawn = drawTile(p, zoom, camX, camY);
			m = measure(drawn.layer);
			const dx = Math.round((IW - artW * n) / 2) - m.art.x0;
			const dy = Math.round((IW - artH * n) / 2) - m.art.y0;
			if (dx === 0 && dy === 0) break;
			camX -= dx / zoom;
			camY -= dy / zoom;
		}
		if (m.texel !== n) throw new Error(`render-products: ${p.file} drew ${m.texel} px a texel, not ${n}`);
		if (Math.round((IW - artW * n) / 2) !== m.art.x0 || Math.round((IW - artH * n) / 2) !== m.art.y0) {
			throw new Error(`render-products: ${p.file} could not be centred on whole pixels`);
		}
		const lo = FRAME + INNER_MARGIN;
		const hi = IW - FRAME - INNER_MARGIN;
		if (m.all.x0 >= lo && m.all.y0 >= lo && m.all.x1 <= hi && m.all.y1 <= hi) return { ...drawn, art: m.art, n };
		drawn.tile.destroy();
	}
	throw new Error(`render-products: ${p.file} does not fit the icon`);
}

// ---------------------------------------------------------------- the backdrop, in theme tokens

/** a flat rect of the backdrop: a Frame in one token, as the UI kit paints its surfaces */
function rect(parent, x, y, w, h, color, z) {
	const f = gui.make("Frame");
	f.BorderSizePixel = 0;
	f.Position = UDim2.fromOffset(x, y);
	f.Size = UDim2.fromOffset(w, h);
	f.BackgroundColor3 = color;
	f.ZIndex = z;
	f.Parent = parent;
	return f;
}

/**
 * The light pool behind the subject, from the outside in (radius in px from the art's centre, token): the game icon's
 * circle of light round the survivor, stepped in the kit's greys from the window's graphite up to the iron plate. The
 * lightest step is under nearly all of the subject, so the darkest cosmetic (the Doberman's black coat) and every
 * sprite's near-black outline stand off it; the outer step just meets the frame mid-side, and the corners stay the
 * page's darkest (THEME.background), as the game icon's round vignette leaves them.
 */
const POOL = [
	{ r: 238, color: SURFACE.window },
	{ r: 222, color: SURFACE.frame },
	{ r: 204, color: SURFACE.cell },
	{ r: 184, color: THEME.secondary },
];

/**
 * The backdrop's Frames: the pool as discs stepped on the subject's texel grid (a cell is filled when its centre is
 * inside the ring: one Frame per run of a row), centred on the art, then the frame round the edge in the tier's colour.
 */
function backdrop(art, n, tier) {
	const layer = gui.make("Frame");
	layer.BackgroundTransparency = 1;
	const cx = (art.x0 + art.x1) / 2;
	const cy = (art.y0 + art.y1) / 2;
	// the grid of the texels: its lines are art.x0 + k * n
	const kx = Math.ceil((art.x0 - FRAME) / n);
	const ky = Math.ceil((art.y0 - FRAME) / n);
	const x0 = art.x0 - kx * n;
	const y0 = art.y0 - ky * n;
	POOL.forEach((ring, i) => {
		for (let y = y0; y < IW - FRAME; y += n) {
			let run;
			const flush = x => {
				if (run === undefined) return;
				const top = Math.max(FRAME, y);
				const bottom = Math.min(IW - FRAME, y + n);
				rect(layer, run, top, x - run, bottom - top, ring.color, 1 + i);
				run = undefined;
			};
			for (let x = x0; x < IW - FRAME; x += n) {
				const inside = Math.hypot(x + n / 2 - cx, y + n / 2 - cy) <= ring.r;
				if (inside && run === undefined) run = Math.max(FRAME, x);
				if (!inside) flush(x);
			}
			flush(IW - FRAME);
		}
	});
	const color = TIER_FRAME[tier];
	const z = 1 + POOL.length;
	rect(layer, 0, 0, IW, FRAME, color, z);
	rect(layer, 0, IW - FRAME, IW, FRAME, color, z);
	rect(layer, 0, FRAME, FRAME, IW - 2 * FRAME, color, z);
	rect(layer, IW - FRAME, FRAME, FRAME, IW - 2 * FRAME, color, z);
	return layer;
}

/** the icon of product `p`: the backdrop, then the tile's sprites over it */
function productIcon(p) {
	const s = drawSubject(p);
	const layer = backdrop(s.art, s.n, p.tier);
	const img = rasterise({ layer, over: [s.layer], vw: IW, vh: IW }, THEME.background, localImage);
	s.tile.destroy();
	return { img, n: s.n };
}

// ---------------------------------------------------------------- the previews (not uploaded)

const rgb = c => [Math.round(c.R * 255), Math.round(c.G * 255), Math.round(c.B * 255)];

/** area-average downscale (what the prompt does to the 512 px upload), as tools/render-promo.mjs previews its icon */
function downscale(src, w, h) {
	const out = { w, h, data: Buffer.alloc(w * h * 4) };
	const fx = src.w / w;
	const fy = src.h / h;
	for (let y = 0; y < h; y++) {
		const y0 = y * fy;
		const y1 = y0 + fy;
		for (let x = 0; x < w; x++) {
			const x0 = x * fx;
			const x1 = x0 + fx;
			const acc = [0, 0, 0];
			let n = 0;
			for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
				const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
				for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
					const k = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * wy;
					const i = (Math.min(src.h - 1, sy) * src.w + Math.min(src.w - 1, sx)) * 4;
					acc[0] += src.data[i] * k;
					acc[1] += src.data[i + 1] * k;
					acc[2] += src.data[i + 2] * k;
					n += k;
				}
			}
			const o = (y * w + x) * 4;
			out.data[o] = Math.round(acc[0] / n);
			out.data[o + 1] = Math.round(acc[1] / n);
			out.data[o + 2] = Math.round(acc[2] / n);
			out.data[o + 3] = 255;
		}
	}
	return out;
}

/** `src` copied into `dst` at (x, y) (both opaque) */
function paste(dst, src, x, y) {
	for (let sy = 0; sy < src.h; sy++) {
		const d = ((y + sy) * dst.w + x) * 4;
		src.data.copy(dst.data, d, sy * src.w * 4, (sy + 1) * src.w * 4);
	}
}

/**
 * One row per tier, each icon at 150 (the purchase prompt) and 50 px, labelled, on the window's graphite: what a
 * player sees before buying. Page and labels are theme tokens too.
 */
function previewSheet(made) {
	const pad = 24;
	const head = 24;
	const label = m => `${m.p.file} (${m.p.tier})`;
	const cellW = Math.max(150 + 12 + 50, ...made.map(m => textWidth(label(m), 2))) + pad;
	const rows = ["common", "rare", "top"].map(t => made.filter(m => m.p.tier === t)).filter(r => r.length > 0);
	const W = pad + Math.max(...rows.map(r => r.length)) * cellW;
	const H = pad + rows.length * (head + 150 + pad);
	const page = rgb(SURFACE.window);
	const img = { w: W, h: H, data: Buffer.alloc(W * H * 4) };
	for (let i = 0; i < W * H; i++) img.data.set([...page, 255], i * 4);
	rows.forEach((row, ry) => {
		const y = pad + ry * (head + 150 + pad);
		row.forEach((m, rx) => {
			const x = pad + rx * cellW;
			drawText(img, label(m), x, y, 2, rgb(THEME.foreground));
			paste(img, downscale(m.img, 150, 150), x, y + head);
			paste(img, downscale(m.img, 50, 50), x + 150 + 12, y + head);
		});
	});
	return img;
}

// ---------------------------------------------------------------- main

function writePNG(file, img) {
	mkdirSync(dirname(file), { recursive: true });
	const bytes = encodePNG(img, true);
	writeFileSync(file, bytes);
	return bytes.length;
}

/** the product ids, when shared/data/robuxProducts.ts exists: printed beside each file for the upload */
function productIds() {
	const file = join(SRC, "shared/data/robuxProducts.ts");
	if (!existsSync(file)) return {};
	return require(file).ROBUX_PRODUCT_IDS ?? {};
}

const all = products();
const unknown = (ONLY ?? []).filter(o => !all.some(p => p.file === o));
if (unknown.length > 0) {
	console.error(`render-products: no costume called ${unknown.join(", ")} (${all.map(p => p.file).join(", ")})`);
	process.exit(2);
}
const ids = productIds();
console.log(`render-products: ${relative(ROOT, OUT) || OUT}`);
const made = [];
for (const p of all) {
	if (ONLY !== undefined && !ONLY.includes(p.file)) continue;
	const { img, n } = productIcon(p);
	const file = join(OUT, "products", `${p.file}.png`);
	const bytes = writePNG(file, img);
	const id = ids[p.costume.name];
	console.log(
		`  ${relative(ROOT, file).padEnd(40)} ${`${img.w}x${img.h}`.padEnd(8)} ${(bytes / 1024).toFixed(0).padStart(3)} KB` +
			`  ${p.tier.padEnd(6)} ${String(n).padStart(2)} px/texel  ${p.costume.name}${id ? `  product ${id}` : ""}`,
	);
	made.push({ p, img });
}
if (ONLY === undefined) {
	const file = join(OUT, "previews", "products.png");
	writePNG(file, previewSheet(made));
	console.log(`  ${relative(ROOT, file)}`);
}
