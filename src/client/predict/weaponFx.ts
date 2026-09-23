/*
 * Predicted weapon feedback: everything a shot LOOKS and FEELS like, decided locally and instantly
 * (docs/MULTIPLAYER.md §2.3 step 1, §2.5 "Cosméticos previstos", §11.3 F2 2C).
 *
 * Nothing in this file decides anything. It draws a muzzle line, kicks the camera and spends a predicted
 * round in the HUD counter; it never touches a zombie's hp, never moves a survivor's hp, never awards XP and
 * never spends the ammo RESERVE (the server owns the pool, and the snapshot corrects the magazine). If this
 * whole module were deleted the game would still be fair — it would just feel like 150 ms of glue.
 *
 * The split follows §2.3:
 *   1. the client shows the flash, the kick, the shake and a tracer with a LOCAL cosmetic spread;
 *   2. the server rolls the real spread with its own RNG and traces the real shot;
 *   3. the `ShotResult` arrives and the real impacts (blood, debris) are played at the real end points.
 *
 * So the predicted tracer is never redrawn when the confirmation lands (that would double every shot), and
 * the predicted shot never draws impact particles (they would land in the wrong place a third of the time).
 * Other players' shots have nothing to predict: their `ShotResult` draws both the line and the impact, from
 * their interpolated body.
 *
 * The cosmetic spread deliberately uses the SAME shape as the server's roll but a different seed: the seed is
 * never replicated (§2.3 "Seed da dispersão"), so a predicted tracer can be a couple of degrees off the real
 * one. Over 0.2 s of tracer life, in the middle of a horde, that is invisible — and it is the price of
 * no-spread cheats being impossible rather than merely detectable (§9.1).
 */
import { DESIGN } from "shared/engine/constants";
import { WeaponDef } from "shared/data/weapons";
import { WeaponKind } from "shared/data/kinds";
import { blocksShots, raycast, rayCircle } from "shared/game/physics";
import { bossHitRadius, BOSS1_SEGMENT_RADIUS, zombieRadius } from "shared/game/entities";
import { FxShot, HitKind } from "shared/net/protocol";
import { WeaponRuntime } from "shared/game/player";
import { fxBlood, fxDebris, fxShake, fxTracer, GameRefs } from "../systems/types";

const DEG = math.pi / 180;

/** how long a shot line stays on screen (it also lights the night) — the same value combat.ts used */
export const TRACER_LIFE = 0.2;
/** electric arcs are shorter */
const ARC_LIFE = 0.15;
/** camera kick of a shot: recoil/10 + 1, for 80 ms (unchanged from the single-player feel) */
const SHAKE_TIME = 0.08;
/** a melee contact shakes a little less, a little longer */
const MELEE_SHAKE = 2;
const MELEE_SHAKE_TIME = 0.06;

/** where a shot line starts: the muzzle, not the body centre */
export function muzzleX(x: number, aim: number): number {
	return x + math.cos(aim) * DESIGN.PLAYER_ARM;
}

export function muzzleY(y: number, aim: number): number {
	return y + math.sin(aim) * DESIGN.PLAYER_ARM;
}

/** the origin of somebody's shot: the local survivor's real position, or an ally's interpolated body */
export interface ShotOrigin {
	x: number;
	y: number;
}

export interface PredictShotOptions {
	/** total spread in degrees (cone + recoil + movement), as the HUD believes it to be */
	spread: number;
	/** cosmetic-only RNG; injectable so the test can replay a run */
	random?: () => number;
	/** false for a silenced weapon: only changes how big the muzzle flash reads */
	loud?: boolean;
}

export class WeaponFx {
	private readonly rnd: () => number;
	/** predicted shots still waiting for their ShotResult (a metric: §12.2 "concordância de acerto") */
	private pending = 0;
	private confirmed = 0;

	constructor(random?: () => number) {
		this.rnd = random ?? (() => math.random());
	}

	/** predicted shots that never got a confirmation, and the ones that did (debug overlay, §12.2) */
	stats(): { pending: number; confirmed: number } {
		return { pending: this.pending, confirmed: this.confirmed };
	}

	/**
	 * The local survivor pulled the trigger: flash, tracer, kick and shake, right now, at frame latency.
	 * `traceLocal` only picks where the LINE stops so it does not paint over a wall — it reads the world
	 * mirror and never writes to it.
	 */
	predictShot(refs: GameRefs, w: WeaponDef, aim: number, options: PredictShotOptions): void {
		const p = refs.player;
		const mx = muzzleX(p.x, aim);
		const my = muzzleY(p.y, aim);
		const pellets = math.max(1, w.pellets);
		for (let i = 0; i < pellets; i++) {
			const a = aim + this.spreadRoll() * options.spread * DEG;
			// (`end` is a Luau keyword: never name a local that, rbxtsc refuses the whole module)
			const stop = this.traceLocal(refs, p.x, p.y, a, w.range);
			fxTracer(
				refs,
				mx,
				my,
				stop.x,
				stop.y,
				w.id === 26 ? "electric" : "bullet",
				w.id === 26 ? ARC_LIFE : TRACER_LIFE,
			);
		}
		fxShake(refs, p, w.recoil / 10 + 1, SHAKE_TIME);
		this.pending += 1;
	}

	/** a bow release or a melee contact: no line, just the thump */
	predictKick(refs: GameRefs, magnitude: number, duration: number): void {
		fxShake(refs, refs.player, magnitude, duration);
	}

	/** the blade connected with something on screen: the hit-stop feel, with no damage behind it */
	predictMeleeContact(refs: GameRefs): void {
		fxShake(refs, refs.player, MELEE_SHAKE, MELEE_SHAKE_TIME);
	}

	/**
	 * The authoritative `ShotResult` (§4.2) arrived. For OUR shot only the impacts are played — the line was
	 * already predicted. For somebody else's, the line is drawn too, from their interpolated body.
	 */
	applyShotResult(refs: GameRefs, shot: FxShot, origin: ShotOrigin, mine: boolean): void {
		if (mine) {
			this.confirmed += 1;
			this.pending = math.max(0, this.pending - 1);
		}
		const ox = origin.x;
		const oy = origin.y;
		for (const h of shot.hits) {
			if (!mine) {
				const arc = shot.weapon === 26;
				fxTracer(refs, ox, oy, h.x, h.y, arc ? "electric" : "bullet", arc ? ARC_LIFE : TRACER_LIFE);
			}
			const away = math.atan2(h.y - oy, h.x - ox);
			if (h.hit === HitKind.Zombie || h.hit === HitKind.Boss) {
				fxBlood(refs, h.x, h.y, 3, "zombie", away);
			} else if (h.hit === HitKind.MapItem) {
				fxDebris(refs, h.x, h.y, 3, "car");
			} else if (h.hit === HitKind.Solid) {
				fxDebris(refs, h.x, h.y, 2, "impact");
			}
		}
	}

	/**
	 * The self block of a snapshot is the truth about the magazine, the reload bar and the recoil cone
	 * (§4.2): whatever the prediction believed, it is replaced here. `reload` is 0..1 of progress and
	 * `spread` the server's current cone in degrees; pass `undefined` for a field the snapshot did not carry.
	 *
	 * Caller beware (client/audio/gameAudio.ts): the gunshot sound is triggered by "the magazine lost a
	 * round", so a correction that LOWERS the count would be heard as an extra shot. Call this before the
	 * audio watcher samples the frame, or re-baseline the watcher after it.
	 */
	reconcile(rt: WeaponRuntime, mag?: number, reload?: number, spread?: number): void {
		if (mag !== undefined && mag >= 0) rt.ammoCount = math.floor(mag);
		if (reload !== undefined) {
			rt.reloading = reload > 0 && reload < 1;
			if (rt.reloadTotal !== undefined && rt.reloadTotal > 0) {
				rt.reloadCount = math.max(0, (1 - reload) * rt.reloadTotal);
			}
		}
		if (spread !== undefined && spread >= 0) rt.angleRange = spread;
	}

	/** the same shape as the server's roll (§2.3), on a seed that is ours alone */
	private spreadRoll(): number {
		const pick = math.floor(this.rnd() * 2);
		return (this.rnd() * 2 - 1) * (pick === 0 ? 1 : 0.6);
	}

	/**
	 * Where the predicted line stops. Reads the local mirror of solids, zombies and bosses purely to pick a
	 * pixel: a wrong guess costs one badly drawn line for 0.2 s, and the confirmation puts the impact in the
	 * right place. This is why nothing here writes.
	 *
	 * The zombies are the DRAWN ones (client/view/actorsView.ts mirrors the interpolated horde into refs.zombies),
	 * each at the instant it is drawn: the buffer's render time, or a near interval before it for a body of the mid
	 * ring. That is the instant the server now judges each one at too (server/sim/combat.ts `prepareTargets`
	 * rewinds a mid-ring target by the same extra delay), so the line stops where the server's ray will. Judged at
	 * the render time instead, a mid-ring body stood 4.5-10 u ahead of this line (the review of 2026-09-23, #2).
	 */
	private traceLocal(refs: GameRefs, x0: number, y0: number, ang: number, range: number): { x: number; y: number } {
		const dx = math.cos(ang);
		const dy = math.sin(ang);
		let best = raycast(refs.world, x0, y0, ang, range, blocksShots).dist;
		for (const z of refs.zombies) {
			if (z.hp <= 0) continue;
			const t = rayCircle(x0, y0, dx, dy, z.x, z.y, zombieRadius(z));
			if (t !== undefined && t < best) best = t;
		}
		for (const b of refs.bosses) {
			if (b.hp <= 0) continue;
			if (b.type === 1 && b.bodyX !== undefined && b.bodyY !== undefined) {
				for (let i = 0; i < b.bodyX.size(); i += 2) {
					const t = rayCircle(x0, y0, dx, dy, b.bodyX[i], b.bodyY[i], BOSS1_SEGMENT_RADIUS);
					if (t !== undefined && t < best) best = t;
				}
			} else {
				const t = rayCircle(x0, y0, dx, dy, b.x, b.y, bossHitRadius(b));
				if (t !== undefined && t < best) best = t;
			}
		}
		return { x: x0 + dx * best, y: y0 + dy * best };
	}
}

/** the spread the HUD believes in: the same sum the server adds up, from the values the client mirrors */
export function predictedSpread(w: WeaponDef, rt: WeaponRuntime, moveSpread: number): number {
	return w.cone + rt.angleRange + moveSpread;
}

/** a weapon whose trigger produces a hitscan line (the flamethrower and the bow do not) */
export function isHitscan(w: WeaponDef): boolean {
	return w.kind !== WeaponKind.Bow && w.id !== 25;
}
