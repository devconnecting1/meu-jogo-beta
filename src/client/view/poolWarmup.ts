/*
 * The world renderer's pool, built before the first fight needs it.
 *
 * The pool grows on demand, and on demand means the frame a horde first walks into view: hundreds of Frames, their
 * UICorners and UIStrokes created at once, and the ScreenGui's Z-order list rebuilt in that same frame. Instead,
 * the sprites a night fight peaks at are created here a few per frame, hidden, at their ZIndex, while the lobby and
 * its menus are on screen and the world renderer draws nothing (shared/engine/renderer.ts: reserve + warm).
 *
 * The counts are a 1920 x 1080 night fight -- 40 walkers, 4 survivors, 40 blood decals, 60 sparks, 12 tracers --
 * per ZIndex, as the real drawers produce them (npm run test:pool draws that fight and holds these numbers to it),
 * flat or pixel art (client/view/charArt.ts, client/view/bloodView.ts) as the uploads decide. With the characters'
 * sheets live, a character's sprite is a Frame and its ImageLabel: both are built here, the label hidden and without
 * a picture (renderer.ts: ensureImage), so the fight creates neither; so is a blood stain's once the blood's atlas is
 * (ART-15). The town itself is not reserved: it is drawn at the run's first frame, behind the mount of the HUD, not in
 * the middle of a fight.
 */
import { Z } from "shared/engine/colors";
import { Renderer } from "shared/engine/renderer";
import { GameContext } from "shared/game/context";
import { bloodArtLive } from "./bloodView";
import { survivorArtLive, zombieArtLive } from "./charArt";

/**
 * [ZIndex, sprites, how many of them are rounded (UICorner), how many outlined (UIStroke), how many draw an image
 * (their ImageLabel; 0 when left out)]
 */
export type PoolLayer = readonly [number, number, number, number, number?];

/** what every look shares: body shadows and tracers */
export const FIGHT_FX: ReadonlyArray<PoolLayer> = [
	[Z.actorShadow, 44, 44, 0],
	[Z.projectile, 12, 0, 0],
];

/** the flat blood (client/view/bloodView.ts): round stains, the acid puddles, round droplets over the bodies */
export const BLOOD_FLAT: ReadonlyArray<PoolLayer> = [
	[Z.decal, 40, 40, 0],
	[Z.decal + 1, 4, 4, 4],
	[Z.particle, 60, 60, 0],
];

/**
 * The blood once its atlas is uploaded (ART-15): a stain is one cell, an image; the droplets are plain squares under
 * the bodies, after the 4 acid puddles of the same layer
 */
export const BLOOD_ART: ReadonlyArray<PoolLayer> = [
	[Z.decal, 40, 0, 0, 40],
	[Z.decal + 1, 64, 4, 4],
];

/** 40 flat walkers (humanoidView.drawHumanoid): feet, arms, body, head */
export const HORDE_FLAT: ReadonlyArray<PoolLayer> = [
	[Z.zombie, 80, 80, 0],
	[Z.zombie + 1, 80, 80, 80],
	[Z.zombie + 2, 40, 40, 40],
	[Z.zombie + 3, 40, 40, 0],
];

/** 40 walkers once the zombies' sheet is uploaded (charArt.drawZombieArt): one cell each, an image */
export const HORDE_ART: ReadonlyArray<PoolLayer> = [[Z.zombie, 40, 0, 0, 40]];

/** 4 flat survivors (survivorView.drawSurvivor, look.z = Z.player) */
export const SURVIVORS_FLAT: ReadonlyArray<PoolLayer> = [
	[Z.player - 1, 8, 8, 0],
	[Z.player, 4, 0, 4],
	[Z.player + 1, 4, 4, 4],
	[Z.player + 3, 8, 8, 0],
	[Z.player + 4, 4, 4, 4],
];

/** 4 survivors once their sheets are uploaded: the body's cell and the weapon's, images both */
export const SURVIVORS_ART: ReadonlyArray<PoolLayer> = [
	[Z.player, 4, 0, 0, 4],
	[Z.player + 1, 4, 0, 0, 4],
];

/** sprites (each with its modifiers) created per frame while warming: a 1080p fight in ~15 frames of the lobby */
export const WARM_PER_FRAME = 32;

/** the reference screen the counts were measured on */
const REF_AREA = 1920 * 1080;

/**
 * Asks `r` for a night fight's sprites on a `viewW` x `viewH` screen: the 1080p counts, down to half of them on a
 * small screen (fewer bodies fit in view), never more.
 */
export function reserveFightPool(
	r: Renderer,
	viewW: number,
	viewH: number,
	zombieArt: boolean,
	survivorArt: boolean,
	bloodArt = false,
): void {
	const k = math.clamp((viewW * viewH) / REF_AREA, 0.5, 1);
	const add = (layers: ReadonlyArray<PoolLayer>): void => {
		for (const [z, n, corners, strokes, images] of layers) {
			r.reserve(
				z,
				math.ceil(n * k),
				math.ceil(corners * k),
				math.ceil(strokes * k),
				math.ceil((images ?? 0) * k),
			);
		}
	};
	add(FIGHT_FX);
	add(bloodArt ? BLOOD_ART : BLOOD_FLAT);
	add(zombieArt ? HORDE_ART : HORDE_FLAT);
	add(survivorArt ? SURVIVORS_ART : SURVIVORS_FLAT);
}

/** the phases in which the world renderer draws nothing: the boot logo is left alone, a run draws the world */
function idle(ctx: GameContext): boolean {
	const p = ctx.phase;
	return p !== "boot" && p !== "playing" && p !== "dead";
}

/**
 * Warms the world renderer on the lobby's frames (and its menus'), WARM_PER_FRAME sprites at a time, then lets go
 * of the frame loop. A run that starts first only pauses it: the run's own frames grow the pool as they always
 * did, and the next lobby finishes what is left. The reservation is taken on the first idle frame, when the
 * viewport and the uploaded art are known.
 */
export function warmFightPool(ctx: GameContext): RBXScriptConnection {
	let reserved = false;
	const conn = game.GetService("RunService").Heartbeat.Connect(() => {
		if (!idle(ctx)) return;
		if (!reserved) {
			reserved = true;
			reserveFightPool(ctx.renderer, ctx.viewW, ctx.viewH, zombieArtLive(), survivorArtLive(), bloodArtLive());
		}
		if (ctx.renderer.warm(WARM_PER_FRAME) === 0) conn.Disconnect();
	});
	return conn;
}
