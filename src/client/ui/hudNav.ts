/*
 * The hand gadgets that show the way (QA E2, 2026-09-23: the Compass and the GPS machine were read by no code).
 *
 *   Compass       a small plate with a needle pointing to your CAMP -- the nearest campfire, brazier or craft desk
 *                 standing in town, the place a survivor builds to spend the night -- and how far it is. With no
 *                 camp it is a plain compass: the needle points north.
 *   GPS machine   a north-up map of the streets and buildings around you (±1600 u, ~58 m each way), with your camp,
 *                 your allies and you on it, and the distance to the camp under it. It is crafted from a compass
 *                 (recipe: compass + parts + chip), and it shows everything the compass does and the town besides.
 *
 * Why these and not the original's: there the compass needle turned with the rotating camera and the GPS printed
 * "X : 312, Y : 88". Our camera never turns (north is always up), so a needle that points north tells nothing, and
 * raw coordinates mean nothing to a player; what a survivor needs at dusk is the way back to where they chose to
 * spend the night, and in a town that is new every world (MP-22), a map of it. Nothing here shows a zombie or a
 * building's loot: only what the survivor already knows (their camp, their allies, the streets) -- MP-07.
 *
 * Which gadget shows what is data (shared/data/equips.ts EQUIP_NAV). Both live in the HAND slot: one at a time, and
 * never together with the flashlight or a watch -- what you hold is a choice.
 *
 * Top left, under the Roblox bar (UI-02), the corner the rest of the HUD leaves free: the console (with the day clock
 * and the survivors chip) at the bottom, the messages at the top centre and the toasts at the top right, and far from
 * the thumbs on touch (UI-09). On touch the clock and the chip sit with Menu and Bag in the top-right corner; only a
 * crowded layout (the largest controls, a squeezed or upright phone) sends them here, the one corner left, and then this
 * plate -- the optional one, shown only with a gadget in hand -- moves down under them (`avoid`). Built once per HUD
 * mount with every frame it can need (the map's pools included): updating it never creates an Instance (test:hud,
 * test:items).
 */
import { EQUIP_NAV, EquipNav } from "shared/data/equips";
import type { PlayerSaveData } from "shared/game/save";
import { querySolids, Solid, WorldData } from "shared/game/world";
import { netActive, remotePlayers } from "../net/netClient";
import { GAME, SURFACE, TEXT, THEME } from "./theme";
import * as W from "./widgets";

/** the tags of what makes a camp: a fire to get through the night, or the desk a base is built round */
const CAMP_TAGS: ReadonlyArray<string> = ["campfire", "brazier", "craftdesk", "craftdesk_pro", "gps"];
/** world units in a metre (DESIGN_RULES §1: 1 m ≈ 55 u) */
const UNITS_PER_METRE = 55;
/** the map shows this far from the survivor each way (world units) */
export const MAP_RANGE = 1600;
/** how often the camp is looked for, and the map redrawn (seconds) */
const CAMP_EVERY = 1;
const MAP_EVERY = 0.25;
/** the needle is turned only once it is off by this much (degrees) */
const NEEDLE_EPS = 0.5;

// design units (the HUD's 1120 × 630 space, × the UI size)
const MARGIN_X = 16;
const MARGIN_Y = 10;
const COMPASS_W = 132;
const COMPASS_H = 44;
const DIAL = 36;
const MAP_W = 156;
const MAP_PAD = 6;
const MAP_SIDE = MAP_W - MAP_PAD * 2;
const CAPTION_H = 22;
const MAP_H = MAP_PAD + MAP_SIDE + CAPTION_H;
/** the pools of the map: enough for the densest downtown window (measured: 40 buildings, 9 roads) */
const MAX_ROADS = 16;
const MAX_BLOCKS = 64;
const MAX_ALLIES = 5;
const MARK = 7;

/** the nearest camp solid (see CAMP_TAGS) to (x, y) anywhere in town, or undefined */
export function nearestCamp(world: WorldData, x: number, y: number): Solid | undefined {
	let best: Solid | undefined;
	let bestD2 = math.huge;
	for (const s of world.solids) {
		if (s.removed === true || !CAMP_TAGS.includes(s.tags)) continue;
		const dx = s.x + s.w / 2 - x;
		const dy = s.y + s.h / 2 - y;
		const d2 = dx * dx + dy * dy;
		if (d2 < bestD2) {
			bestD2 = d2;
			best = s;
		}
	}
	return best;
}

/** the gadget in the survivor's hand that shows the way, if any */
export function navGadgetOf(save: PlayerSaveData): EquipNav | undefined {
	return save.equipHand >= 0 ? EQUIP_NAV[save.equipHand] : undefined;
}

/**
 * The screen rect the plate can take on a `vw` x `vh` screen with the Roblox bar `inset` px tall, at the HUD size `k`,
 * in px [left, top, right, bottom], before `avoid` moves it: the larger of its two faces, the GPS map, both anchored at
 * the same corner (makeAnchored's recipe, as hud.ts messageReach).
 */
export function navReach(vw: number, vh: number, inset: number, k: number): [number, number, number, number] {
	const s = math.min(vw / W.DESIGN_W, vh / W.DESIGN_H) * k;
	const x = (MARGIN_X / W.DESIGN_W) * vw;
	const y = inset + (MARGIN_Y / W.DESIGN_H) * vh;
	return [x, y, x + MAP_W * s, y + MAP_H * s];
}

/** the needle's turn towards (dx, dy) in the Rotation convention (degrees clockwise from screen-up = world north) */
export function bearingDeg(dx: number, dy: number): number {
	return math.deg(math.atan2(dx, -dy));
}

/** "85 m" */
function metres(d: number): string {
	return `${W.fmtInt(math.floor(d / UNITS_PER_METRE + 0.5))} m`;
}

export class HudNav {
	/** what the plates show now: undefined = nothing in hand that shows the way */
	mode: EquipNav | undefined;
	/** the camp the needle and the map point at (undefined: none standing) */
	camp: Solid | undefined;
	readonly compass: Frame;
	readonly map: Frame;
	private readonly tr: (key: string) => string;
	private readonly needle: Frame;
	private readonly compassTitle: TextLabel;
	private readonly compassValue: TextLabel;
	private readonly well: Frame;
	private readonly caption: TextLabel;
	private readonly roads: Array<Frame> = [];
	private readonly blocks: Array<Frame> = [];
	private readonly allies: Array<Frame> = [];
	private readonly campMark: Frame;
	private readonly selfMark: Frame;
	private readonly scratch = new Array<Solid>();
	private nextCamp = 0;
	private nextMap = 0;
	private angle = math.huge;
	private texts = new Map<TextLabel, string>();
	/** both plates, full screen: moved down (never sideways) by `avoid`, so the plates keep makeAnchored's own place */
	private readonly holder: Frame;
	private readonly k: number;

	constructor(root: Frame, tr: (key: string) => string, k: number) {
		this.tr = tr;
		this.k = k;
		const holder = new Instance("Frame");
		holder.Name = "Nav";
		holder.BackgroundTransparency = 1;
		holder.BackgroundColor3 = THEME.background;
		holder.BorderSizePixel = 0;
		holder.Size = UDim2.fromScale(1, 1);
		holder.ZIndex = 2;
		holder.Parent = root;
		this.holder = holder;
		// ---- the compass: a dial with the needle, what it points at and how far
		const compass = W.makeAnchored(holder, "NavCompass", 0, 0, COMPASS_W, COMPASS_H, MARGIN_X, MARGIN_Y, true, k);
		compass.ZIndex = 2;
		compass.Visible = false;
		this.compass = compass;
		const body = W.Card(compass, "Body", { x: 0, y: 0, w: COMPASS_W, h: COMPASS_H, fill: SURFACE.window, pad: 6 });
		const z = body.ZIndex + 1;
		const dialAt = (COMPASS_H - DIAL) / 2;
		const dial = W.makeFrame(body, "Dial", dialAt, dialAt, DIAL, DIAL, SURFACE.well, {
			zIndex: z,
			radius: DIAL / 2,
			stroke: SURFACE.line,
		});
		// the needle turns as one piece round the dial's centre (a GuiObject's Rotation turns its children with it)
		this.needle = W.makeFrame(dial, "Needle", 0, 0, DIAL, DIAL, THEME.background, {
			transparency: 1,
			zIndex: z + 1,
		});
		W.makeFrame(this.needle, "Tip", DIAL / 2 - 2, 4, 4, DIAL / 2 - 4, GAME.hp, { zIndex: z + 2 });
		W.makeFrame(this.needle, "Tail", DIAL / 2 - 2, DIAL / 2, 4, DIAL / 2 - 6, THEME.foreground, { zIndex: z + 2 });
		const textX = COMPASS_H + 2;
		const textW = COMPASS_W - textX - 8;
		this.compassTitle = W.makeLabel(body, "Target", "", textX, 5, textW, 18, TEXT.sm, THEME.foreground, {
			font: "label",
			align: "left",
			zIndex: z,
		});
		this.compassValue = W.makeLabel(body, "Distance", "", textX, 23, textW, 15, TEXT.xs, THEME.mutedForeground, {
			mono: true,
			weight: Enum.FontWeight.Regular,
			align: "left",
			zIndex: z,
		});

		// ---- the GPS: the map well, its pools, north, and the distance to the camp under it
		const map = W.makeAnchored(holder, "NavMap", 0, 0, MAP_W, MAP_H, MARGIN_X, MARGIN_Y, true, k);
		map.ZIndex = 2;
		map.Visible = false;
		this.map = map;
		const mapBody = W.Card(map, "Body", { x: 0, y: 0, w: MAP_W, h: MAP_H, fill: SURFACE.window, pad: MAP_PAD });
		const mz = mapBody.ZIndex + 1;
		const well = W.makeFrame(mapBody, "Map", MAP_PAD, MAP_PAD, MAP_SIDE, MAP_SIDE, SURFACE.well, {
			zIndex: mz,
			clips: true,
			stroke: SURFACE.line,
		});
		this.well = well;
		for (let i = 0; i < MAX_ROADS; i++) this.roads.push(this.poolFrame("Road", SURFACE.line, mz + 1));
		for (let i = 0; i < MAX_BLOCKS; i++) this.blocks.push(this.poolFrame("Block", SURFACE.section, mz + 2));
		this.campMark = this.poolFrame("Camp", GAME.warning, mz + 3);
		for (let i = 0; i < MAX_ALLIES; i++) this.allies.push(this.poolFrame("Ally", THEME.foreground, mz + 4));
		this.selfMark = W.makeFrame(
			well,
			"You",
			(MAP_SIDE - MARK) / 2,
			(MAP_SIDE - MARK) / 2,
			MARK,
			MARK,
			THEME.primary,
			{
				zIndex: mz + 5,
				stroke: THEME.foreground,
			},
		);
		W.makeLabel(well, "North", tr("N"), MAP_SIDE / 2 - 8, 1, 16, 14, TEXT.xs, THEME.foreground, {
			font: "label",
			zIndex: mz + 6,
		});
		this.caption = W.makeLabel(
			mapBody,
			"Caption",
			"",
			MAP_PAD,
			MAP_PAD + MAP_SIDE + 3,
			MAP_SIDE,
			16,
			TEXT.xs,
			THEME.foreground,
			{
				font: "caption",
				align: "left",
				zIndex: mz,
			},
		);
	}

	/**
	 * One frame of the HUD: which plate shows (the hand's gadget), the needle, and -- 4 times a second -- the map.
	 * `now` is the HUD's clock (seconds).
	 */
	/**
	 * hud.ts, on touch, whenever the touch geometry changes (never per frame): what of the HUD's corner pieces (the sky's
	 * plate, the survivors chip) a crowded layout put in this plate's column pushes it down under them, a margin clear,
	 * and never off the screen.
	 */
	avoid(rects: ReadonlyArray<[number, number, number, number]>): void {
		const v = W.viewportSize();
		const [x0, y0, x1, y1] = navReach(v.X, v.Y, W.topInset(), this.k);
		const h = y1 - y0;
		const gap = MARGIN_Y * math.min(v.X / W.DESIGN_W, v.Y / W.DESIGN_H);
		let top = y0;
		for (let pass = 0; pass < 4; pass++) {
			let moved = false;
			for (const r of rects) {
				if (r[0] < x1 && x0 < r[2] && r[1] < top + h && top < r[3] + gap) {
					top = r[3] + gap;
					moved = true;
				}
			}
			if (!moved) break;
		}
		top = math.min(top, math.max(y0, v.Y - h));
		const push = math.round(top - y0);
		if (this.holder.Position.Y.Offset !== push) this.holder.Position = UDim2.fromOffset(0, push);
	}

	update(world: WorldData, x: number, y: number, save: PlayerSaveData, now: number): void {
		const mode = navGadgetOf(save);
		if (mode !== this.mode) {
			this.mode = mode;
			this.compass.Visible = mode === "compass";
			this.map.Visible = mode === "map";
			this.nextCamp = 0;
			this.nextMap = 0;
		}
		if (mode === undefined) return;
		if (now >= this.nextCamp) {
			this.nextCamp = now + CAMP_EVERY;
			this.camp = nearestCamp(world, x, y);
		}
		const camp = this.camp !== undefined && this.camp.removed !== true ? this.camp : undefined;
		const dx = camp !== undefined ? camp.x + camp.w / 2 - x : 0;
		const dy = camp !== undefined ? camp.y + camp.h / 2 - y : -1;
		const away = camp !== undefined ? metres(math.sqrt(dx * dx + dy * dy)) : "";
		if (mode === "compass") {
			const angle = bearingDeg(dx, dy);
			if (math.abs(angle - this.angle) >= NEEDLE_EPS) {
				this.angle = angle;
				this.needle.Rotation = angle;
			}
			this.setText(this.compassTitle, this.tr(camp !== undefined ? "Camp" : "North"));
			this.setText(this.compassValue, camp !== undefined ? away : this.tr("No camp yet"));
			return;
		}
		this.setText(this.caption, camp !== undefined ? `${this.tr("Camp")} · ${away}` : this.tr("No camp yet"));
		if (now < this.nextMap) return;
		this.nextMap = now + MAP_EVERY;
		this.drawMap(world, x, y, camp);
	}

	hide(): void {
		this.mode = undefined;
		this.compass.Visible = false;
		this.map.Visible = false;
	}

	// ---------------------------------------------------------------- the map

	private poolFrame(name: string, color: Color3, zIndex: number): Frame {
		const f = W.makeFrame(this.well, name, 0, 0, 1, 1, color, { zIndex });
		f.Visible = false;
		return f;
	}

	/** puts pooled frame `f` over the world rect (rx, ry, rw, rh) clipped to the window, or hides it */
	private placeRect(f: Frame, x0: number, y0: number, rx: number, ry: number, rw: number, rh: number): boolean {
		const span = MAP_RANGE * 2;
		const ax = math.max(rx, x0);
		const ay = math.max(ry, y0);
		const bx = math.min(rx + rw, x0 + span);
		const by = math.min(ry + rh, y0 + span);
		if (bx <= ax || by <= ay) {
			if (f.Visible) f.Visible = false;
			return false;
		}
		f.Position = UDim2.fromScale((ax - x0) / span, (ay - y0) / span);
		f.Size = UDim2.fromScale((bx - ax) / span, (by - ay) / span);
		if (!f.Visible) f.Visible = true;
		return true;
	}

	/** a marker (camp, ally) centred on a world point, or hidden when it is off the map */
	private placeMark(f: Frame, x0: number, y0: number, wx: number, wy: number, size: number): void {
		const span = MAP_RANGE * 2;
		const u = (wx - x0) / span;
		const v = (wy - y0) / span;
		if (u < 0 || u > 1 || v < 0 || v > 1) {
			if (f.Visible) f.Visible = false;
			return;
		}
		const s = size / MAP_SIDE;
		f.Position = UDim2.fromScale(u - s / 2, v - s / 2);
		f.Size = UDim2.fromScale(s, s);
		if (!f.Visible) f.Visible = true;
	}

	private drawMap(world: WorldData, x: number, y: number, camp: Solid | undefined): void {
		const x0 = x - MAP_RANGE;
		const y0 = y - MAP_RANGE;
		let r = 0;
		for (const road of world.roads) {
			if (r >= MAX_ROADS) break;
			if (this.placeRect(this.roads[r], x0, y0, road.x, road.y, road.w, road.h)) r++;
		}
		for (let i = r; i < MAX_ROADS; i++) if (this.roads[i].Visible) this.roads[i].Visible = false;
		const found = this.scratch;
		found.clear();
		querySolids(world, x0, y0, x0 + MAP_RANGE * 2, y0 + MAP_RANGE * 2, found);
		let b = 0;
		for (const s of found) {
			if (b >= MAX_BLOCKS) break;
			if (s.kind !== "building" || s.removed === true) continue;
			if (this.placeRect(this.blocks[b], x0, y0, s.x, s.y, s.w, s.h)) b++;
		}
		found.clear();
		for (let i = b; i < MAX_BLOCKS; i++) if (this.blocks[i].Visible) this.blocks[i].Visible = false;
		if (camp !== undefined) {
			this.placeMark(this.campMark, x0, y0, camp.x + camp.w / 2, camp.y + camp.h / 2, MARK + 2);
		} else if (this.campMark.Visible) {
			this.campMark.Visible = false;
		}
		const allies = netActive() ? remotePlayers() : undefined;
		for (let i = 0; i < MAX_ALLIES; i++) {
			const a = allies?.[i];
			if (a !== undefined) this.placeMark(this.allies[i], x0, y0, a.x, a.y, MARK - 1);
			else if (this.allies[i].Visible) this.allies[i].Visible = false;
		}
	}

	private setText(label: TextLabel, text: string): void {
		if (this.texts.get(label) === text) return;
		this.texts.set(label, text);
		label.Text = text;
	}
}
