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
}

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
 * A survivor standing or crawling, weapon in hand, with their drop shadow.
 * `trail` is this survivor's melee-sweep memory and is updated in place.
 */
export function drawSurvivor(r: Renderer, cam: Camera, look: SurvivorLook, trail: SwingTrail): void {
	if (look.downed) {
		trail.drawn = false;
		drawDowned(r, cam, look);
		return;
	}
	const a = look.angle;
	r.drawCircle(cam, look.x + look.shadowX, look.y + look.shadowY, 38, {
		color: BLACK,
		alpha: 0.3,
		zIndex: Z.actorShadow,
	});
	const flash = clamp(look.flash, 0, 1);
	const pal = outfitPalette(look.outfit);
	// poison wins over any outfit: it is a gameplay signal (LEG-02), the coat is only a cosmetic
	let body = look.poisoned ? COLORS.zombie5 : pal.body;
	if (flash > 0) body = body.Lerp(pal.flashTo, 0.85 * flash);
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
	// weapon + hands
	const w = look.weapon;
	handCount = 0;
	const wasSwinging = trail.drawn;
	trail.drawn = w.kind === WeaponKind.Melee && look.swinging;
	if (w.kind === WeaponKind.Melee) {
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
			r.drawSegment(
				cam,
				look.x + math.cos(sa) * 14,
				look.y + math.sin(sa) * 14,
				look.x + math.cos(sa) * reach,
				look.y + math.sin(sa) * reach,
				{ h: 6, color: COLORS.blade, stroke: COLORS.weapon, strokeThickness: 1, zIndex: look.z },
			);
			hand(16 * math.cos(sa - a), 16 * math.sin(sa - a));
			hand(10, -14);
		} else {
			// idle: blade held low in the right hand, pointing forward-out
			const ha = a + 0.5;
			const hx = look.x + math.cos(a) * 12 - math.sin(a) * 14;
			const hy = look.y + math.sin(a) * 12 + math.cos(a) * 14;
			const len = math.max(18, reach * 0.55);
			r.drawSegment(cam, hx, hy, hx + math.cos(ha) * len, hy + math.sin(ha) * len, {
				h: 5,
				color: COLORS.blade,
				stroke: COLORS.weapon,
				strokeThickness: 1,
				zIndex: look.z,
			});
			hand(12, 14);
			hand(10, -14);
		}
	} else if (w.kind === WeaponKind.Bow) {
		part(r, cam, look.x, look.y, a, 26, 0, {
			w: 6,
			h: 44,
			color: COLORS.arrow.Lerp(BLACK, 0.3),
			cornerRadius: 3,
			zIndex: look.z,
		});
		hand(24, 0);
		hand(10, 8);
	} else {
		let len = 42;
		if (w.kind === WeaponKind.Pistol) len = 22;
		else if (w.kind === WeaponKind.Shotgun) len = 40;
		else if (w.kind === WeaponKind.MG) len = 50;
		else if (w.kind === WeaponKind.Sniper) len = 56;
		part(r, cam, look.x, look.y, a, 12 + len / 2, 3, {
			w: len,
			h: w.kind === WeaponKind.Pistol ? 6 : 7,
			color: COLORS.weapon,
			zIndex: look.z,
		});
		if (w.kind === WeaponKind.Pistol) {
			hand(18, 6);
			hand(18, -2);
		} else {
			hand(16, 7);
			hand(12 + len * 0.6, 3);
		}
	}
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

/**
 * Downed (MP-03): flat on the ground, dragging themselves forward at 20% speed, both hands busy, so no
 * weapon. The silhouette is the standing one turned 90°, long along the heading instead of wide across
 * it — from above that difference alone says "someone is down" before you read their plate. The red tint
 * is the one red already means (LEG-02: player blood / damage), and the shadow tightens because the body
 * is already on the floor. The outfit keeps its colours on the torso and the head (MON-04: you can still tell
 * WHO is down), under the same red tint and outline.
 */
function drawDowned(r: Renderer, cam: Camera, look: SurvivorLook): void {
	const a = look.angle;
	const pal = outfitPalette(look.outfit);
	const body = pal.body.Lerp(COLORS.uiRed, 0.35);
	const dark = COLORS.playerDark.Lerp(BLACK, 0.2);
	part(r, cam, look.x + look.shadowX * 0.4, look.y + look.shadowY * 0.4, a, 0, 0, {
		w: 48,
		h: 28,
		color: BLACK,
		alpha: 0.28,
		cornerRadius: 14,
		zIndex: Z.actorShadow,
	});
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
