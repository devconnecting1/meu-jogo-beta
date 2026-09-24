/*
 * Last Town plates: the pixel plates of the reference art (docs/DESIGN_RULES.md UI-07), drawn with Frames.
 *
 * Every pressable, key, tab and tile of the kit is the same notched shape, one RELIEF UNIT per band:
 *
 *        . L L L L L L .      L = light band / upper ears: `foreground` washed over the face
 *        L F F F F F F L      F = face: the variant's token (iron, blue, red, dark iron)
 *        L F F F F F F L
 *        D F F F F F F D      D = lower ears / lip: `background` washed over the face
 *        . D D D D D D .      . = the cut corner (the "pixel chamfer")
 *
 * A FLAT plate (an inactive tab, a section, a row cell, a tile) is the same notched shape with no bands; the
 * reference raises only what is active or pressable.
 *
 * Why Frames and not the 9-slice skin (skin.ts): the uploaded textures have a dark outline and no side ears, so
 * they cannot draw this shape, and new textures would mean new uploads. A plate is at most eight Frames, built
 * once per host and afterwards only re-coloured, shown or hidden -- a state change creates no Instance -- and
 * laid out in screen pixels, so every band is a whole number of pixels at any UI scale. It needs no asset, so
 * the flat fallback of the skin (no textures) draws exactly the same plates.
 *
 * Colour rule (UI-01): every Frame here is painted with EXACTLY one theme token. The light and the dark of the
 * relief are `foreground` and `background` at a fixed transparency over the face -- the same washes the skin
 * textures carry in their alpha (btnLight, btnShade) -- so what reaches the screen is a token composited over
 * a token, never a colour anyone typed. They are relief, not "see the world through this": the player's
 * transparency preference does not apply to them (it would flatten the bevel, not show the world).
 */
import { onLayoutChange, uiScale } from "./skin";
import { THEME } from "./theme";

/**
 * flat: no bands; idle / hot: raised (hot = hover or focus, a brighter light); press: pushed in;
 * outline: the band, ears and lip become one opaque ring around the face (a disabled plate: a dark slot with a
 * line around it, drawn by the SAME frames, so disabling a button creates nothing)
 */
export type PlateState = "flat" | "idle" | "hot" | "press" | "outline";

/** Roblox transparency (1 - alpha) of the relief washes */
const WASH = {
	/** light band and upper ears, at rest: `foreground` at 30% */
	light: 0.7,
	/** hover / focus: `foreground` at 50% */
	lightHot: 0.5,
	/** lip and lower ears: `background` at 45% */
	shade: 0.55,
	/** pressed: the band becomes an inner shadow, `background` at 35% */
	pressShade: 0.65,
};

/** under every child a screen adds (kit content starts at ZIndex 1), above the hidden skin layers (-10..-8) */
const Z_FACE = -6;
const Z_RELIEF = -5;

/** relief unit (design units) of a plate `h` design units tall: the reference's 4 on a 34-tall tab, less when small */
export function plateUnit(h: number): number {
	if (h >= 28) return 4;
	if (h >= 18) return 3;
	return 2;
}

/** screen pixels of `units` design units of relief: a whole number, never below 1 */
export function reliefPx(units: number): number {
	return math.max(1, math.round(units * uiScale()));
}

function designHeight(host: GuiObject): number {
	const h = host.GetAttribute("DesignH");
	return typeIs(h, "number") && h > 0 ? h : 40;
}

function part(host: GuiObject, name: string, zIndex: number): Frame {
	const f = new Instance("Frame");
	f.Name = name;
	f.BorderSizePixel = 0;
	f.Active = false;
	f.Selectable = false;
	f.ZIndex = zIndex;
	f.BackgroundColor3 = THEME.background;
	f.BackgroundTransparency = 1;
	f.Visible = false;
	f.Parent = host;
	return f;
}

function put(
	f: Frame,
	xs: number,
	xo: number,
	ys: number,
	yo: number,
	ws: number,
	wo: number,
	hs: number,
	ho: number,
): void {
	f.Position = new UDim2(xs, xo, ys, yo);
	f.Size = new UDim2(ws, wo, hs, ho);
}

function wash(f: Frame, on: boolean, color: Color3, transparency: number): void {
	f.Visible = on;
	if (!on) return;
	f.BackgroundColor3 = color;
	f.BackgroundTransparency = transparency;
}

// ---------------------------------------------------------------- plates

interface Plate {
	/** relief unit, design units */
	unit: number;
	/** centre column (full height) and middle row (full width): together, the notched face */
	faceV: Frame;
	faceH: Frame;
	band: Frame;
	earL: Frame;
	earR: Frame;
	earLD: Frame;
	earRD: Frame;
	lip: Frame;
}

const plates = new Map<GuiObject, Plate>();

function layoutPlate(p: Plate): void {
	const u = reliefPx(p.unit);
	put(p.faceV, 0, u, 0, 0, 1, -2 * u, 1, 0);
	put(p.faceH, 0, 0, 0, u, 1, 0, 1, -2 * u);
	put(p.band, 0, u, 0, 0, 1, -2 * u, 0, u);
	put(p.earL, 0, 0, 0, u, 0, u, 1, -3 * u);
	put(p.earR, 1, -u, 0, u, 0, u, 1, -3 * u);
	put(p.earLD, 0, 0, 1, -2 * u, 0, u, 0, u);
	put(p.earRD, 1, -u, 1, -2 * u, 0, u, 0, u);
	put(p.lip, 0, u, 1, -u, 1, -2 * u, 0, u);
}

function buildPlate(host: GuiObject, unit: number): Plate {
	const p: Plate = {
		unit,
		faceV: part(host, "PlateFace", Z_FACE),
		faceH: part(host, "PlateFaceH", Z_FACE),
		band: part(host, "PlateBand", Z_RELIEF),
		earL: part(host, "PlateEarL", Z_RELIEF),
		earR: part(host, "PlateEarR", Z_RELIEF),
		earLD: part(host, "PlateEarLD", Z_RELIEF),
		earRD: part(host, "PlateEarRD", Z_RELIEF),
		lip: part(host, "PlateLip", Z_RELIEF),
	};
	plates.set(host, p);
	host.Destroying.Connect(() => plates.delete(host));
	onLayoutChange(host, () => layoutPlate(p));
	return p;
}

/**
 * Draws (or redraws) the plate on `host` in `face`, in `state`. The frames are created on the first call and only
 * repainted afterwards. `unit` defaults to the host's design height (plateUnit); `edge` is the ring colour of the
 * "outline" state.
 */
export function paintPlate(
	host: GuiObject,
	face: Color3,
	state: PlateState = "idle",
	unit?: number,
	edge: Color3 = THEME.border,
): void {
	const u = unit ?? plateUnit(designHeight(host));
	let p = plates.get(host);
	if (p === undefined) {
		p = buildPlate(host, u);
	} else if (p.unit !== u) {
		p.unit = u;
		layoutPlate(p);
	}
	wash(p.faceV, true, face, 0);
	wash(p.faceH, true, face, 0);
	if (state === "outline") {
		for (const f of [p.band, p.earL, p.earR, p.earLD, p.earRD, p.lip]) wash(f, true, edge, 0);
		return;
	}
	const raised = state === "idle" || state === "hot";
	const light = state === "hot" ? WASH.lightHot : WASH.light;
	if (state === "press") wash(p.band, true, THEME.background, WASH.pressShade);
	else wash(p.band, raised, THEME.foreground, light);
	wash(p.earL, raised, THEME.foreground, light);
	wash(p.earR, raised, THEME.foreground, light);
	wash(p.earLD, raised, THEME.background, WASH.shade);
	wash(p.earRD, raised, THEME.background, WASH.shade);
	wash(p.lip, raised, THEME.background, WASH.shade);
}

/** hides the plate of `host` (kept for the next paint: a button going disabled and back creates nothing) */
export function clearPlate(host: GuiObject): void {
	const p = plates.get(host);
	if (p === undefined) return;
	for (const f of [p.faceV, p.faceH, p.band, p.earL, p.earR, p.earLD, p.earRD, p.lip]) f.Visible = false;
}

// ---------------------------------------------------------------- segments (two-tone rows)

/*
 * A settings row is ONE notched shape in two tones: the label cell on the left, the value cell on the right, with
 * no notch at the join (as in the reference). A segment is the part of the host between two fractions of its
 * width, notched only on the corners that are corners of the host.
 */

interface Segment {
	column: Frame;
	middle: Frame;
}

/**
 * Paints the part of `host` between `from` and `to` (fractions of its width) in `color`: a flat plate cut at the
 * host's own corners only. Keyed by `name`, so a repaint recolours the same two frames.
 */
export function paintSegment(
	host: GuiObject,
	name: string,
	color: Color3,
	from: number,
	to: number,
	unit: number,
): void {
	const key = `Seg${name}`;
	let column = host.FindFirstChild(`${key}C`) as Frame | undefined;
	let middle = host.FindFirstChild(`${key}M`) as Frame | undefined;
	if (column === undefined || middle === undefined) {
		const seg: Segment = { column: part(host, `${key}C`, Z_FACE), middle: part(host, `${key}M`, Z_FACE) };
		column = seg.column;
		middle = seg.middle;
		const left = from <= 0 ? 1 : 0;
		const right = to >= 1 ? 1 : 0;
		onLayoutChange(seg.column, () => {
			const u = reliefPx(unit);
			put(seg.column, from, left * u, 0, 0, to - from, -(left + right) * u, 1, 0);
			put(seg.middle, from, 0, 0, u, to - from, 0, 1, -2 * u);
		});
	}
	wash(column, true, color, 0);
	wash(middle, true, color, 0);
}

// ---------------------------------------------------------------- the padlock (grid tiles)

/** a 7 x 9 pixel padlock in `color` with its keyhole in `hole`, filling `host` (keep the host at 7:9) */
export function drawPadlock(host: GuiObject, color: Color3, hole: Color3, zIndex: number): void {
	const px = (name: string, x: number, y: number, w: number, h: number, c: Color3): void => {
		const f = part(host, name, zIndex);
		put(f, x / 7, 0, y / 9, 0, w / 7, 0, h / 9, 0);
		wash(f, true, c, 0);
	};
	// shackle: an arch of 1 px bars over the body
	px("ShackleTop", 2, 0, 3, 1, color);
	px("ShackleL", 1, 1, 1, 3, color);
	px("ShackleR", 5, 1, 1, 3, color);
	// body, with its two cut corners, and the keyhole
	px("Body", 0, 5, 7, 3, color);
	px("BodyTop", 1, 4, 5, 1, color);
	px("BodyBottom", 1, 8, 5, 1, color);
	px("Keyhole", 3, 5, 1, 2, hole);
}
