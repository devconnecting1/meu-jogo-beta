/*
 * One survivor's body. The local player and every ally go through this single function
 * (docs/MULTIPLAYER.md §5.3: "o `drawPlayer` atual, parametrizado por estado"), so an ally can never
 * drift into looking like a different species than you: same silhouette, same hands, same weapon in
 * them, same feet, same shadow, same layers.
 *
 * The caller owns a `SurvivorLook` and refills it every frame — the hot path allocates nothing.
 *
 * MON-04: the outfit a survivor wears is part of the look (`outfit`, an OutfitLook), and it is drawn HERE, by the
 * same function, for everyone — the colours of the torso, feet, hands and head come from its palette and the
 * pieces on top (belt, rips, vest, hats) from client/view/cosmeticsView.ts. The plain palette is exactly the
 * survivor as it was drawn before, so nobody without an outfit changes by a pixel.
 *
 * Layers, from `look.z` (= Z.player): feet z-1, weapon z, torso z+1, what the outfit puts on the torso z+2,
 * hands z+3, head (or a hat's brim) z+4, a hat's crown z+5. Every piece has a layer of its own because Roblox does
 * not promise an order between siblings of equal ZIndex.
 */
import { COLORS, Z } from "shared/engine/colors";
import { Camera } from "shared/engine/camera";
import { Renderer } from "shared/engine/renderer";
import { WeaponKind } from "shared/data/kinds";
import { OutfitLook } from "shared/data/cosmetics";
import { WeaponDef, WEAPONS } from "shared/data/weapons";
import { angleDiff, clamp } from "shared/engine/vec2";
import { drawOutfitHead, drawOutfitTorso, outfitPalette } from "./cosmeticsView";
import { part, SIDES } from "./drawKit";
import { columnOf, drawSurvivorCell, drawWeaponCell, survivorArtLive } from "./charArt";
import { Grip, HANDLE, downedRow, gripOf, gunLength, survivorRow, swingRow, weaponRow } from "./charSheets";

const WHITE = COLORS.white;
const BLACK = COLORS.shadow;

/** night light radius of a standing survivor (LUZ-02/MP-08: every survivor lights the map for everyone) */
export const SURVIVOR_LIGHT_R = 250;
/** the chainsaw's weapon id: it cuts continuously instead of sweeping an arc */
const CHAINSAW_ID = 5;
/** longest motion trail behind a swinging blade (radians) */
const SWING_TRAIL = 0.5;
/** body half-width; a survivor drawn any wider than their hitbox would be a lie (COL-01) */
export const SURVIVOR_R = 18;

/**
 * Carried between frames so a melee sweep can be drawn from where it started instead of jumping to the
 * blade's current angle. One per survivor: only the local one swings in F1, allies get theirs when the
 * snapshot starts carrying `swing` (shared/net/protocol.ts) in F2.
 */
export interface SwingTrail {
	/** a blade was drawn last frame */
	drawn: boolean;
	/** its angle relative to the aim */
	rel: number;
}

export function createSwingTrail(): SwingTrail {
	return { drawn: false, rel: 0 };
}

/** everything the body needs to be drawn, in world units */
export interface SurvivorLook {
	x: number;
	y: number;
	/** facing / aim (radians) */
	angle: number;
	/** what they hold */
	weapon: WeaponDef;
	/** walk cycle: phase in radians and how far the feet swing (0 = standing still) */
	feetPhase: number;
	feetAmp: number;
	/** 1 right after a hit, fading to 0 */
	flash: number;
	/** poisoned survivors go green like the poison zombie (LEG-02) */
	poisoned: boolean;
	/** downed survivors crawl, unarmed (MP-03) */
	downed: boolean;
	/** a melee sweep is in progress */
	swinging: boolean;
	/** the blade's world angle and how far it reaches */
	swingAngle: number;
	swingReach: number;
	/** offset of the drop shadow (drawKit.shadowOffset) */
	shadowX: number;
	shadowY: number;
	/** the torso sits at `z + 1` (layers above): allies pass Z.player like the local survivor and are drawn first */
	z: number;
	/** seconds since the session started (chainsaw vibration) */
	clock: number;
	/** what they wear (OutfitLook, MON-04); 0 = the plain survivor */
	outfit: number;
	/**
	 * (VEI-05) On a bicycle or a motorcycle: both hands on the bars and no weapon in them, the feet on the pedals
	 * (the caller passes feetAmp 0), and no body shadow -- the vehicle drawn under them casts it
	 * (client/view/vehicleView.ts). The body, the outfit and the layers are the standing survivor's, untouched.
	 */
	riding: boolean;
	/**
	 * (DESIGN_RULES ITM-06) The weapon is put away: nothing in the hands, both at rest beside the body -- the local
	 * survivor from `PlayerState.holstered`, an ally from the WEAPON_HOLSTERED byte of the wire (protocol.ts note 20).
	 */
	holstered: boolean;
}

/** where a rider's hands hold the bars, in the body's frame (both vehicles put their bars there) */
export const RIDE_GRIP_F = 17;
export const RIDE_GRIP_L = 13;

export function createLook(): SurvivorLook {
	return {
		x: 0,
		y: 0,
		angle: 0,
		weapon: WEAPONS[0],
		feetPhase: 0,
		feetAmp: 0,
		flash: 0,
		poisoned: false,
		downed: false,
		swinging: false,
		swingAngle: 0,
		swingReach: 46,
		shadowX: 0,
		shadowY: 0,
		z: Z.player,
		clock: 0,
		outfit: OutfitLook.None,
		riding: false,
		holstered: false,
	};
}

/** the weapon a survivor holds, by id (allies arrive as a `weaponId` byte) */
export function weaponById(id: number): WeaponDef {
	if (id >= 0 && id < WEAPONS.size()) return WEAPONS[id];
	return WEAPONS[0];
}

/** hands to draw this frame, in the body's own frame; module scratch so a frame allocates nothing */
const HAND_F = [0, 0];
const HAND_L = [0, 0];
let handCount = 0;

function hand(f: number, l: number): void {
	HAND_F[handCount] = f;
	HAND_L[handCount] = l;
	handCount++;
}

/**
 * The pixel art's pose this frame (module scratch): the weapons-sheet row and where the weapon's centre is in the
 * body frame, its heading off the aim, and the body's grip -- or, mid-swing, the sweep angle the body cell is
 * picked by (the hands are baked into it, charSheets.GRIP_HANDS / SWINGS).
 */
const WEAPON = { row: 0, f: 0, l: 0, rel: 0, grip: 0, swinging: false };
/** WEAPON.row of empty hands: no weapon cell is drawn (a rider, VEI-05; a weapon put away, ITM-06) */
const NO_WEAPON = -1;

function holdWeapon(row: number, f: number, l: number, rel: number, grip: number, swinging: boolean): void {
	WEAPON.row = row;
	WEAPON.f = f;
	WEAPON.l = l;
	WEAPON.rel = rel;
	WEAPON.grip = grip;
	WEAPON.swinging = swinging;
}


/**
 * A survivor standing or crawling, weapon in hand, with their drop shadow.
 * `trail` is this survivor's melee-sweep memory and is updated in place.
 *
 * Two looks, one pose: the pixel art of client/view/charArt.ts once its sheets are uploaded (ART-09), the flat
 * drawing otherwise (ART-01: without ids nothing changes, call for call). Both read the same hands, the same weapon
 * placement and the same sweep below, so the two can never disagree on where a blade is.
 */
export function drawSurvivor(r: Renderer, cam: Camera, look: SurvivorLook, trail: SwingTrail): void {
	const art = survivorArtLive();
	if (look.downed) {
		trail.drawn = false;
		drawDowned(r, cam, look, art);
		return;
	}
	const a = look.angle;
	if (!look.riding) {
		r.drawCircle(cam, look.x + look.shadowX, look.y + look.shadowY, 38, {
			color: BLACK,
			alpha: 0.3,
			zIndex: Z.actorShadow,
		});
	}
	const flash = clamp(look.flash, 0, 1);
	const pal = outfitPalette(look.outfit);
	if (!art) {
		// feet
		const step = math.sin(look.feetPhase) * 8 * look.feetAmp;
		for (const side of SIDES) {
			part(r, cam, look.x, look.y, a, step * side, side * 9, {
				w: 12,
				h: 9,
				color: pal.boots,
				cornerRadius: 3,
				zIndex: look.z - 1,
			});
		}
	}
	// weapon + hands
	const w = look.weapon;
	handCount = 0;
	const wasSwinging = trail.drawn;
	trail.drawn = !look.riding && !look.holstered && w.kind === WeaponKind.Melee && look.swinging;
	if (look.riding) {
		// VEI-05: both hands on the bars, nothing in them
		hand(RIDE_GRIP_F, -RIDE_GRIP_L);
		hand(RIDE_GRIP_F, RIDE_GRIP_L);
		// the pixel art: no weapon cell (WEAPON is a scratch: left alone it would hold the last survivor's weapon),
		// and the sheets bake no riding pose, so the idle grip: both hands out at the bars' width (±14 u, the bars ±13)
		if (art) holdWeapon(NO_WEAPON, 0, 0, 0, Grip.Idle, false);
	} else if (look.holstered) {
		// ITM-06: the weapon put away -- empty hands at rest, where the blade's idle hold keeps them, and (the pixel
		// art) no weapon cell
		if (art) holdWeapon(NO_WEAPON, 0, 0, 0, Grip.Idle, false);
		hand(IDLE_HAND_F, IDLE_HAND_L);
		hand(10, -14);
	} else if (w.kind === WeaponKind.Melee) {
		const reach = look.swingReach;
		if (look.swinging) {
			// Combat sweeps the hit test over [-cone, +cone] around the aim, and its first update
			// already advances the blade. Draw the same arc: the first frame shows the blade at
			// -cone (where the sweep began), later frames at the blade's angle clamped to +cone,
			// and the trail only over the part already swept. The chainsaw does not sweep: its bar
			// points at the aim and just vibrates (its bite is symmetric around the aim too).
			const half = w.id === CHAINSAW_ID ? 0 : math.rad(w.cone);
			let rel = clamp(angleDiff(a, look.swingAngle), -half, half);
			// a new sweep: nothing drawn last frame, or the blade went back (only moves forward)
			const fresh = !wasSwinging || rel < trail.rel - 0.01;
			trail.rel = rel;
			if (fresh) rel = -half;
			if (w.id === CHAINSAW_ID) rel = math.sin(look.clock * 90) * 0.03;
			const sa = a + rel;
			const swept = clamp(rel + half, 0, SWING_TRAIL);
			// motion trail over the swept part of the arc, then the blade itself
			for (let i = 0; i < 2; i++) {
				const o = i === 0 ? -swept : -swept * 0.5;
				const al = i === 0 ? 0.15 : 0.3;
				const ta = sa + o;
				r.drawSegment(
					cam,
					look.x + math.cos(ta) * 16,
					look.y + math.sin(ta) * 16,
					look.x + math.cos(ta) * reach,
					look.y + math.sin(ta) * reach,
					{ h: 8, color: WHITE, alpha: al, zIndex: look.z },
				);
			}
			if (art) {
				// the blade from 14 u out to its reach, turned `rel` off the aim (the chainsaw's bar shakes a texel)
				const mid = (14 + reach) / 2;
				const shake = w.id === CHAINSAW_ID && math.sin(look.clock * 90) > 0 ? 4 : 0;
				const f = mid * math.cos(rel);
				const l = mid * math.sin(rel) + shake;
				holdWeapon(weaponRow(w.id, w.kind, false), f, l, rel, Grip.Idle, true);
			} else {
				r.drawSegment(
					cam,
					look.x + math.cos(sa) * 14,
					look.y + math.sin(sa) * 14,
					look.x + math.cos(sa) * reach,
					look.y + math.sin(sa) * reach,
					{ h: 6, color: COLORS.blade, stroke: COLORS.weapon, strokeThickness: 1, zIndex: look.z },
				);
			}
			hand(16 * math.cos(sa - a), 16 * math.sin(sa - a));
			hand(10, -14);
		} else {
			// idle: blade held low in the right hand, pointing forward-out
			const len = math.max(18, reach * 0.55);
			if (art) {
				// the hand on the middle of the handle, the blade out from it
				const out = len * 0.5 - HANDLE;
				const f = IDLE_HAND_F + math.cos(IDLE_TILT) * out;
				const l = IDLE_HAND_L + math.sin(IDLE_TILT) * out;
				holdWeapon(weaponRow(w.id, w.kind, true), f, l, IDLE_TILT, Grip.Idle, false);
			} else {
				const ha = a + IDLE_TILT;
				const hx = look.x + math.cos(a) * IDLE_HAND_F - math.sin(a) * IDLE_HAND_L;
				const hy = look.y + math.sin(a) * IDLE_HAND_F + math.cos(a) * IDLE_HAND_L;
				r.drawSegment(cam, hx, hy, hx + math.cos(ha) * len, hy + math.sin(ha) * len, {
					h: 5,
					color: COLORS.blade,
					stroke: COLORS.weapon,
					strokeThickness: 1,
					zIndex: look.z,
				});
			}
			hand(IDLE_HAND_F, IDLE_HAND_L);
			hand(10, -14);
		}
	} else if (w.kind === WeaponKind.Bow) {
		if (art) {
			holdWeapon(weaponRow(w.id, w.kind, false), 26, 0, 0, Grip.Bow, false);
		} else {
			part(r, cam, look.x, look.y, a, 26, 0, {
				w: 6,
				h: 44,
				color: COLORS.arrow.Lerp(BLACK, 0.3),
				cornerRadius: 3,
				zIndex: look.z,
			});
		}
		hand(24, 0);
		hand(10, 8);
	} else {
		const len = gunLength(w.kind);
		if (art) {
			holdWeapon(weaponRow(w.id, w.kind, false), 12 + len / 2, 3, 0, gripOf(w.kind), false);
		} else {
			part(r, cam, look.x, look.y, a, 12 + len / 2, 3, {
				w: len,
				h: w.kind === WeaponKind.Pistol ? 6 : 7,
				color: COLORS.weapon,
				zIndex: look.z,
			});
		}
		if (w.kind === WeaponKind.Pistol) {
			hand(18, 6);
			hand(18, -2);
		} else {
			hand(16, 7);
			hand(12 + len * 0.6, 3);
		}
	}
	if (art) {
		drawStandingArt(r, cam, look, flash, pal.flashTo);
		return;
	}
	// poison wins over any outfit: it is a gameplay signal (LEG-02), the coat is only a cosmetic
	let body = look.poisoned ? COLORS.zombie5 : pal.body;
	if (flash > 0) body = body.Lerp(pal.flashTo, 0.85 * flash);
	// body (shoulders across the heading); a hit always shows as the thick red outline, whatever the coat
	part(r, cam, look.x, look.y, a, 0, 0, {
		w: 24,
		h: 38,
		color: body,
		cornerRadius: 10,
		stroke: flash > 0 ? COLORS.uiRed : pal.edge,
		strokeThickness: flash > 0 ? 3 : pal.edgeThick,
		zIndex: look.z + 1,
	});
	// what the outfit puts on the torso (z + 2): belt, rips, vest
	drawOutfitTorso(r, cam, look.x, look.y, a, look.z, look.outfit);
	for (let i = 0; i < handCount; i++) {
		part(r, cam, look.x, look.y, a, HAND_F[i], HAND_L[i], {
			w: 10,
			h: 10,
			circle: true,
			color: pal.hands,
			zIndex: look.z + 3,
		});
	}
	// the head, or the hat on it (z + 4, z + 5)
	drawOutfitHead(r, cam, look.x, look.y, a, look.z, look.outfit);
}

/** the idle melee hold: the hand beside the hip, the blade turned out this far from the aim */
const IDLE_HAND_F = 12;
const IDLE_HAND_L = 14;
const IDLE_TILT = 0.5;
/**
 * How much of the poison colour veils a poisoned survivor's body in the pixel art, and how far a hit's flash covers
 * it at its peak: the flat drawing turned only the torso, the art tints the whole silhouette, so less of it keeps
 * the head, the hands and the outfit readable under the colour.
 */
const POISON_VEIL = 0.5;
const FLASH_FILL = 0.6;

/**
 * The pixel-art survivor (ART-09), from the weapon and the grip the pose above decided: the weapon (z; a rider has
 * none), then the whole body -- boots, torso, what the outfit carries, both arms with the hands on that grip, the
 * head or hat -- as one cell (z + 1), the poison veil (z + 2), and a hit's flash and red outline (z + 3). The weapon
 * is snapped to the body's texel grid (charArt.snapped).
 */
function drawStandingArt(r: Renderer, cam: Camera, look: SurvivorLook, flash: number, flashTo: Color3): void {
	const a = look.angle;
	const x = look.x;
	const y = look.y;
	const z = look.z;
	const c = math.cos(a);
	const s = math.sin(a);
	const col = columnOf(cam, a);
	const wf = WEAPON.f;
	const wl = WEAPON.l;
	if (WEAPON.row !== NO_WEAPON) {
		drawWeaponCell(r, cam, WEAPON.row, x, y, x + c * wf - s * wl, y + s * wf + c * wl, a + WEAPON.rel, z);
	}
	const outfit = look.outfit;
	const row = WEAPON.swinging
		? swingRow(outfit, WEAPON.rel)
		: survivorRow(outfit, WEAPON.grip, math.sin(look.feetPhase) * look.feetAmp);
	drawSurvivorCell(r, cam, outfit, 0, row, col, x, y, z + 1, 1, WHITE);
	// poison wins over any outfit (LEG-02): a veil of the poison colour over the whole body
	if (look.poisoned) drawSurvivorCell(r, cam, outfit, 1, row, col, x, y, z + 2, POISON_VEIL, COLORS.zombie5);
	if (flash > 0) {
		// a hit: the body towards the flash colour (red; white on Santa's red coat) and the thick red outline
		drawSurvivorCell(r, cam, outfit, 1, row, col, x, y, z + 3, FLASH_FILL * flash, flashTo);
		drawSurvivorCell(r, cam, outfit, 2, row, col, x, y, z + 3, 1, COLORS.uiRed);
	}
}

/**
 * Downed (MP-03): flat on the ground, dragging themselves forward at 20% speed, both hands busy, so no
 * weapon. The silhouette is the standing one turned 90°, long along the heading instead of wide across
 * it — from above that difference alone says "someone is down" before you read their plate. The red tint
 * is the one red already means (LEG-02: player blood / damage), and the shadow tightens because the body
 * is already on the floor. The outfit keeps its colours on the torso and the head (MON-04: you can still tell
 * WHO is down), under the same red tint and outline.
 */
function drawDowned(r: Renderer, cam: Camera, look: SurvivorLook, art: boolean): void {
	const a = look.angle;
	part(r, cam, look.x + look.shadowX * 0.4, look.y + look.shadowY * 0.4, a, 0, 0, {
		w: 48,
		h: 28,
		color: BLACK,
		alpha: 0.28,
		cornerRadius: 14,
		zIndex: Z.actorShadow,
	});
	if (art) {
		// one baked cell: flat on the belly, arms pulling, the survivor's-blood outline (ART-09, LEG-02)
		const drag = math.sin(look.feetPhase) * math.max(look.feetAmp, 0.25);
		const row = downedRow(look.outfit, drag);
		drawSurvivorCell(r, cam, look.outfit, 0, row, columnOf(cam, a), look.x, look.y, look.z + 2, 1, WHITE);
		return;
	}
	const pal = outfitPalette(look.outfit);
	const body = pal.body.Lerp(COLORS.uiRed, 0.35);
	const dark = COLORS.playerDark.Lerp(BLACK, 0.2);
	// legs trailing behind and arms pulling ahead, out of phase: a crawl, not a walk
	const drag = math.sin(look.feetPhase) * 5 * math.max(look.feetAmp, 0.25);
	for (const side of SIDES) {
		part(r, cam, look.x, look.y, a, -18 + drag * side, side * 7, {
			w: 18,
			h: 8,
			color: dark.Lerp(BLACK, 0.35),
			cornerRadius: 3,
			zIndex: look.z,
		});
		part(r, cam, look.x, look.y, a, 20 - drag * side, side * 10, {
			w: 22,
			h: 7,
			color: dark,
			cornerRadius: 3,
			zIndex: look.z + 1,
		});
	}
	part(r, cam, look.x, look.y, a, 0, 0, {
		w: 36,
		h: 22,
		color: body,
		cornerRadius: 9,
		stroke: COLORS.uiRed,
		strokeThickness: 2,
		zIndex: look.z + 2,
	});
	// head down, cheek on the asphalt
	r.drawCircle(cam, look.x + math.cos(a) * 17, look.y + math.sin(a) * 17, 18, {
		color: pal.head.Lerp(COLORS.uiRed, 0.2),
		stroke: BLACK,
		strokeThickness: 1,
		strokeAlpha: 0.5,
		zIndex: look.z + 3,
	});
}
