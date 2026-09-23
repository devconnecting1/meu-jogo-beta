/*
 * The horde and the bosses on screen (docs/MULTIPLAYER.md §4.2, §5.1, §11.3 F2-2D).
 *
 * Two jobs live here, and the file is split in two halves to keep them apart:
 *
 *   (a) the MIRROR   `sync` rebuilds `refs.zombies` / `refs.bosses` out of the interpolated bodies the
 *                    network layer hands over (`remoteZombies` / `remoteBosses`). It writes the very same
 *                    `ZombieState` / `BossState` the single-player game uses, on purpose: the tree canopies
 *                    (`gameLoop.updateCanopy`), the audio watcher, the stuck arrows and the admin overlay
 *                    already read those two arrays, so phase 2 costs them exactly zero changes.
 *   (b) the DRAWING  the actor half of what `gameLoop.ts` drew until F2 — zombies, bosses, arrows and
 *                    projectiles — moved here verbatim, with the loop's private helpers replaced by
 *                    `drawKit.part` and an `ActorDrawOpts` the caller fills.
 *
 * The split matters because the two halves have different owners in different phases. Below MP_PHASE 2 the
 * client simulates the horde itself and `sync` is never called; from 2 on the server owns every body and the
 * mirror is the ONLY writer of those arrays. The drawing does not care which of the two filled them.
 *
 * Nothing here allocates per frame after the warm-up: one `ZombieState` per netId, one `BossState` per boss,
 * reused until the body stops arriving.
 */
import {
	BossState,
	BOSS1_SEGMENT_RADIUS,
	bossHitRadius,
	ZombieState,
	ZombieType,
	zombieRadius,
} from "shared/game/entities";
import { Camera, ViewRect } from "shared/engine/camera";
import { circleInView, part, SIDES } from "./drawKit";
import { drawHumanoid, drawZombie } from "./humanoidView";
import { COLORS, Z } from "shared/engine/colors";
import { GameRefs, SPEED_SCALE } from "../systems/types";
import { remoteBosses, remoteZombies, takeZombieDeaths, ZombieDeathEvent } from "../net/netClient";
import { RemoteBoss, RemoteZombie } from "../net/snapshotBuffer";
import { clamp } from "shared/engine/vec2";
import { FUSE_TIME } from "shared/sim/ai/zombieTuning";
import { Renderer } from "shared/engine/renderer";
import { ZombieFlag } from "shared/net/protocol";

const WHITE = COLORS.white;
const BLACK = COLORS.shadow;
/** humanoid sprites are 36 × scale wide at the shoulders: scale = hit radius / 18 matches the hitbox */
const HUMANOID_HALF_WIDTH = 18;
/** spitter puddle size (zombieAI) — the landing marker of an acid blob uses it */
const SPIT_MARK_R = 40;

/** what a zombie's drop shadow falls on, and the loop's animation clock; see `ActorDrawOpts` */
export interface ActorDrawOpts {
	/** where the shadow of something at (x, y) falls, for a shadow `len` long (LUZ-01) */
	shadow: (x: number, y: number, len: number) => { x: number; y: number };
	/** the loop's animation clock in accumulated seconds (leg swing, tentacles, flames) */
	clock: number;
}

// ================================================================ (a) the mirror

/**
 * Pair of the scale `server/net/replication.ts` packs the spitter's head recoil with (§4.2: `headX` is 0..10
 * and the wire byte is 0..255). It is deliberately a copy and not an import: `shared/net/protocol.ts` is the
 * one place both sides already share, and the server module has no business being reachable from a view.
 * If one of the two ever moves, the other is one grep away — and the comment on both says so.
 */
const SPIT_EXTRA_SCALE = 25;
/** the big walker variant (`createZombie`: 5 % of the walkers from day 3) */
const BIG_SCALE = 1.4;
/** the centipede's body: 50 segments, each pulled to 30 u of the one ahead (`bossBrain.updateSerpent`) */
const BOSS1_SEGMENTS = 50;
const BOSS1_SPACING = 30;
/**
 * A lit fuse never reaches zero in the mirror. `drawZombies` blinks at a frequency of 1 / time-left and
 * treats `fuse > 0` as "still standing", so a fuse that ran out would stop the blink and drop the body to
 * the corpse layer while the server still has it walking at you.
 */
const FUSE_MIN = 0.05;

export class ActorsView {
	/** one mirrored body per netId, kept between frames so a frame allocates nothing */
	private readonly zPool = new Map<number, ZombieState>();
	private readonly bPool = new Map<number, BossState>();
	/** which sync last touched each pooled body, so the ones that stopped arriving can be dropped */
	private readonly zSeen = new Map<number, number>();
	private readonly bSeen = new Map<number, number>();
	private readonly gone = new Array<number>();
	private readonly deaths = new Array<ZombieDeathEvent>();
	private syncNo = 0;
	/** `drawBullets` bookkeeping: the frame stamp and the by-id index the stuck arrows need */
	private frameNo = 0;
	private readonly zombieById = new Map<number, ZombieState>();
	/** stuck arrows: the victim's heading when the arrow went in, so it turns with the body */
	private readonly stuckRef = new Map<number, { a: number; seen: number }>();

	/**
	 * Rebuilds `refs.zombies` and `refs.bosses` from this frame's interpolated snapshot (§5.1).
	 *
	 * `onDeath` is called once per reliable `ZombieDied` (§4.4) BEFORE the lists are rebuilt, so the view it
	 * belongs to (client/view/fxView.ts) plays the blood where the body actually fell instead of where the
	 * interpolation had last guessed it to be.
	 */
	sync(refs: GameRefs, dt: number, onDeath: (d: ZombieDeathEvent) => void): void {
		this.syncNo += 1;
		const stamp = this.syncNo;
		this.deaths.clear();
		takeZombieDeaths(this.deaths);
		for (const d of this.deaths) onDeath(d);
		const zombies = refs.zombies;
		zombies.clear();
		for (const rz of remoteZombies()) {
			const z = this.zombieFor(rz.netId);
			this.fillZombie(z, rz, dt);
			this.zSeen.set(rz.netId, stamp);
			zombies.push(z);
		}
		this.retire(this.zPool, this.zSeen, stamp);
		const bosses = refs.bosses;
		bosses.clear();
		for (const rb of remoteBosses()) {
			const fresh = !this.bPool.has(rb.netId);
			const b = this.bossFor(rb.netId, rb.type);
			this.fillBoss(b, rb);
			// the centipede's 50 segments are NOT on the wire (§4.2 sends one 14-byte head): the body is
			// rebuilt here from the interpolated head with the simulation's own follow-the-leader rule
			if (b.type === 1) this.followHead(b, fresh);
			this.bSeen.set(rb.netId, stamp);
			bosses.push(b);
		}
		this.retire(this.bPool, this.bSeen, stamp);
	}

	/** a new world (a new run, a rebirth): every mirrored body and every stuck-arrow memory goes */
	reset(): void {
		this.zPool.clear();
		this.bPool.clear();
		this.zSeen.clear();
		this.bSeen.clear();
		this.zombieById.clear();
		this.stuckRef.clear();
	}

	private retire<T>(pool: Map<number, T>, seen: Map<number, number>, stamp: number): void {
		const gone = this.gone;
		gone.clear();
		for (const [netId, at] of seen) {
			if (at !== stamp) gone.push(netId);
		}
		for (const netId of gone) {
			pool.delete(netId);
			seen.delete(netId);
		}
	}

	private zombieFor(netId: number): ZombieState {
		const found = this.zPool.get(netId);
		if (found !== undefined) return found;
		/*
		 * Everything below the drawn fields is a neutral value with NO owner in phase 2: the server decides
		 * damage, experience, knockback, wandering and the spawn point, and none of it is on the wire (§4.2
		 * is 9 bytes). They exist because `ZombieState` is the single-player type and the rest of the client
		 * reads it; a client that acted on them would be simulating a horde it does not own.
		 */
		const z: ZombieState = {
			id: netId,
			type: 1,
			x: 0,
			y: 0,
			spawnX: 0,
			spawnY: 0,
			hp: 1,
			hpMax: 1,
			damage: 0,
			moveSpeed: 0,
			exp: 0,
			angle: 0,
			angleSlow: 0,
			detect: false,
			detectShow: 0,
			stunned: 0,
			attacked: false,
			iframe: 0,
			reactionSpeed: 0,
			reactionDir: 0,
			wanderTimer: 0,
			wanderDir: 0,
			wave: false,
			alpha: 0,
			feetCycle: 0,
			hitFlash: 0,
			scale: 1,
			fuse: -1,
			special: false,
		};
		this.zPool.set(netId, z);
		return z;
	}

	private fillZombie(z: ZombieState, rz: RemoteZombie, dt: number): void {
		const flags = rz.flags;
		z.type = rz.type as ZombieType;
		z.special = rz.type !== 1;
		z.x = rz.x;
		z.y = rz.y;
		// the wire carries the heading the server DREW with (`angleSlow`), so both fields are that one
		// value: turning the body again here would be a second animation on top of the one already sent
		z.angle = rz.angle;
		z.angleSlow = rz.angle;
		z.alpha = rz.alpha;
		z.feetCycle = rz.feetCycle;
		z.scale = rz.big ? BIG_SCALE : 1;
		// px/frame @30 fps, the unit `moveSpeed` is in; read back from the speed the interpolation measured
		z.moveSpeed = rz.speed / SPEED_SCALE;
		z.detect = (flags & ZombieFlag.Detect) !== 0;
		// the wire has a bit, not a countdown: the "!" is up exactly while the server says it is up
		z.detectShow = z.detect ? 1 : 0;
		// what the awareness marks draw (client/view/zombieAwareness.ts): the state the server decided, 2 bits of
		// the record (protocol decision 16)
		z.aware = rz.aware;
		z.stunned = (flags & ZombieFlag.Stunned) !== 0 ? 1 : 0;
		z.hitFlash = (flags & ZombieFlag.HitFlash) !== 0 ? 1 : 0;
		const jumping = (flags & ZombieFlag.Jumping) !== 0;
		z.jumping = jumping;
		z.jumpHeight = jumping ? rz.extra : 0;
		z.rush = (flags & ZombieFlag.Charging) !== 0;
		z.headX = (flags & ZombieFlag.SpitPrep) !== 0 ? rz.extra / SPIT_EXTRA_SCALE : 0;
		/*
		 * A zombie's hp is not on the wire and does not need to be: the client draws bodies, and the only
		 * thing the drawing asks of hp is "is this one still standing?". The single exception is the lit
		 * exploder, which is the one state that is down (hp ≤ 0) and still drawn walking, so FuseLit is
		 * exactly the bit that answers it. The fuse itself counts down locally, purely so the red blink
		 * accelerates as it does in the simulation — the server decides WHEN it blows up, not this.
		 */
		const lit = (flags & ZombieFlag.FuseLit) !== 0;
		z.hp = lit ? 0 : 1;
		const burning = z.fuse !== undefined && z.fuse > 0 ? z.fuse : FUSE_TIME;
		z.fuse = lit ? math.max(FUSE_MIN, burning - dt) : -1;
	}

	private bossFor(netId: number, bossType: number): BossState {
		const found = this.bPool.get(netId);
		if (found !== undefined) return found;
		// same rule as the horde: only the fields the drawing reads are filled, the rest is inert
		const b: BossState = {
			id: netId,
			type: bossType,
			x: 0,
			y: 0,
			hp: 1,
			hpMax: 1,
			hpRecover: 0,
			damage: 0,
			exp: 0,
			moveSpeed: 0,
			angle: 0,
			attackCd: 0,
			dead: false,
			hitFlash: 0,
		};
		if (bossType === 1) {
			const bodyX = new Array<number>();
			const bodyY = new Array<number>();
			for (let i = 0; i < BOSS1_SEGMENTS; i++) {
				bodyX.push(0);
				bodyY.push(0);
			}
			b.bodyX = bodyX;
			b.bodyY = bodyY;
			b.bodyNumber = BOSS1_SEGMENTS;
		}
		this.bPool.set(netId, b);
		return b;
	}

	private fillBoss(b: BossState, rb: RemoteBoss): void {
		b.type = rb.type;
		b.x = rb.x;
		b.y = rb.y;
		b.angle = rb.angle;
		// §4.2 carries a boss's health as a fraction of its own maximum, so the mirror's maximum is 1
		b.hp = rb.hp;
		b.hpMax = 1;
		b.dead = false;
		b.hitFlash = (rb.flags & ZombieFlag.HitFlash) !== 0 ? 1 : 0;
		// one animation counter per type, both raw (§4.2 `phase`): degrees of the walk cycle for the
		// humanoid boss, the serpent's body cursor for the centipede
		if (rb.type === 3) b.moveCycle = rb.phase;
		else if (rb.type === 1) b.movePos = rb.phase;
	}

	/**
	 * The centipede's body, following the interpolated head exactly as `bossBrain.updateSerpent` does: every
	 * segment is pulled to BOSS1_SPACING of the one ahead of it, and only THEN does the head take its new
	 * place. The order is the animation — pulling against the head's OLD position is what makes the chain lag
	 * a step behind and whip through a turn instead of sliding rigidly after it.
	 */
	private followHead(b: BossState, fresh: boolean): void {
		const bodyX = b.bodyX;
		const bodyY = b.bodyY;
		if (bodyX === undefined || bodyY === undefined) return;
		const n = bodyX.size();
		if (fresh) {
			// first sight: the whole body starts coiled on the head, and unrolls as it moves
			for (let i = 0; i < n; i++) {
				bodyX[i] = b.x;
				bodyY[i] = b.y;
			}
			return;
		}
		for (let i = 1; i < n; i++) {
			const dx = bodyX[i - 1] - bodyX[i];
			const dy = bodyY[i - 1] - bodyY[i];
			const d = math.sqrt(dx * dx + dy * dy);
			if (d < 1) continue;
			const pull = d - BOSS1_SPACING;
			bodyX[i] += (dx / d) * pull;
			bodyY[i] += (dy / d) * pull;
		}
		bodyX[0] = b.x;
		bodyY[0] = b.y;
	}

	// ================================================================ (b) the drawing

	drawZombies(r: Renderer, cam: Camera, v: ViewRect, refs: GameRefs, opts: ActorDrawOpts): void {
		const up = cam.screenDirToWorld(0, -1);
		for (const zb of refs.zombies) {
			const rad = zombieRadius(zb);
			if (!circleInView(zb.x, zb.y, rad * 3.5 + 40, v)) continue;
			const alpha = clamp(zb.alpha, 0, 1);
			if (alpha <= 0.01) continue;
			const sc = rad / HUMANOID_HALF_WIDTH;
			// jumper: the body rises (0..28) and grows a little; the shadow stays on the ground
			const lift = math.max(0, zb.jumpHeight ?? 0);
			const liftScale = 1 + lift / 100;
			const so = opts.shadow(zb.x, zb.y, 10);
			r.drawCircle(cam, zb.x + so.x, zb.y + so.y, (rad * 2.1) / liftScale, {
				color: BLACK,
				alpha: 0.3 * alpha * (1 - lift / 70),
				zIndex: Z.actorShadow,
			});
			const fuse = zb.fuse ?? -1;
			// lit fuse: red blink that accelerates as it burns (frequency ∝ 1 / time left)
			const blink = zb.type === 3 && fuse > 0 && math.sin(math.pi * 2 * 3 * math.log(fuse + 0.1)) > 0;
			const bx = zb.x + up.x * lift;
			const by = zb.y + up.y * lift;
			const standing = zb.hp > 0 || fuse > 0;
			const flash = clamp(zb.hitFlash ?? 0, 0, 1);
			const windup = zb.type === 2 ? (zb.headX ?? 0) : 0;
			const z = standing ? Z.zombie : Z.zombie - 5;
			// the pixel art of the type (ART-10) once its sheet is uploaded; the flat humanoid otherwise (ART-01)
			drawZombie(
				r,
				cam,
				bx,
				by,
				zb.angleSlow,
				sc * liftScale,
				zb.type,
				flash,
				alpha,
				zb.feetCycle ?? 0,
				z,
				windup,
				lift > 0,
				zb.rush === true,
				blink,
			);
			// the "!" that used to be drawn here is now one of the awareness marks (client/view/zombieAwareness.ts,
			// drawn by the loop above the night overlay): dot, "?" or "!" for every state the server decides
		}
	}

	drawBosses(r: Renderer, cam: Camera, v: ViewRect, refs: GameRefs, opts: ActorDrawOpts): void {
		for (const b of refs.bosses) {
			const flash = clamp(b.hitFlash ?? 0, 0, 1);
			const color = flash > 0 ? COLORS.boss.Lerp(WHITE, 0.7 * flash) : COLORS.boss;
			const dark = COLORS.boss.Lerp(BLACK, 0.4);
			if (b.type === 1) {
				const bodyX = b.bodyX;
				const bodyY = b.bodyY;
				if (bodyX === undefined || bodyY === undefined) continue;
				// centipede: every segment is drawn at its hit radius, the head at bossHitRadius
				const n = bodyX.size();
				const seg = BOSS1_SEGMENT_RADIUS * 2;
				const head = bossHitRadius(b) * 2;
				for (let i = n - 1; i >= 0; i--) {
					const size = i === 0 ? head : seg;
					if (!circleInView(bodyX[i], bodyY[i], size, v)) continue;
					if (i > 0 && i % 3 === 0) {
						// legs on every third segment, across the local body direction
						const j0 = math.max(0, i - 1);
						const j1 = math.min(n - 1, i + 1);
						const da = math.atan2(bodyY[j0] - bodyY[j1], bodyX[j0] - bodyX[j1]);
						const swing = math.sin(opts.clock * 12 + i) * 0.35;
						for (const side of SIDES) {
							part(r, cam, bodyX[i], bodyY[i], da + side * (math.pi / 2 + swing), seg * 0.55, 0, {
								w: seg * 0.5,
								h: 7,
								color: dark,
								cornerRadius: 3,
								zIndex: Z.boss - 1,
							});
						}
					}
					r.drawCircle(cam, bodyX[i], bodyY[i], size, {
						color: i === 0 || i % 2 === 0 ? color : color.Lerp(BLACK, 0.2),
						stroke: dark,
						strokeThickness: 2,
						zIndex: Z.boss + (i === 0 ? 2 : 0),
					});
				}
				if (n > 1) {
					const ha = math.atan2(bodyY[0] - bodyY[1], bodyX[0] - bodyX[1]);
					for (const side of SIDES) {
						part(r, cam, bodyX[0], bodyY[0], ha, head * 0.22, side * head * 0.2, {
							w: head * 0.12,
							h: head * 0.12,
							circle: true,
							color: COLORS.detect,
							zIndex: Z.boss + 3,
						});
						// mandibles
						part(r, cam, bodyX[0], bodyY[0], ha + side * 0.35, head * 0.55, 0, {
							w: head * 0.3,
							h: 8,
							color: dark,
							cornerRadius: 3,
							zIndex: Z.boss + 1,
						});
					}
				}
				continue;
			}
			// types 2-4: drawn at their hit radius so what you see is what you hit
			const size = bossHitRadius(b) * 2;
			if (!circleInView(b.x, b.y, size + 60, v)) continue;
			const so = opts.shadow(b.x, b.y, 14);
			r.drawCircle(cam, b.x + so.x, b.y + so.y, size * 1.05, {
				color: BLACK,
				alpha: 0.35,
				zIndex: Z.actorShadow,
			});
			if (b.type === 3) {
				drawHumanoid(
					r,
					cam,
					b.x,
					b.y,
					b.angle,
					size / 2 / HUMANOID_HALF_WIDTH,
					color,
					flash,
					1,
					math.rad(b.moveCycle ?? 0),
					Z.boss,
				);
				continue;
			}
			if (b.type === 2) {
				// tentacles slowly sweeping around the stationary body
				for (let i = 0; i < 6; i++) {
					const ta = opts.clock * 0.6 + (i * math.pi) / 3;
					part(r, cam, b.x, b.y, ta, size * 0.62, 0, {
						w: 80,
						h: 16,
						color: dark,
						cornerRadius: 8,
						zIndex: Z.boss,
					});
				}
			} else {
				// needles
				for (let i = 0; i < 8; i++) {
					part(r, cam, b.x, b.y, b.angle + (i * math.pi) / 4, size * 0.55, 0, {
						w: 30,
						h: 8,
						color: dark,
						zIndex: Z.boss,
					});
				}
			}
			r.drawCircle(cam, b.x, b.y, size, {
				color,
				stroke: flash > 0 ? WHITE : dark,
				strokeThickness: flash > 0 ? 4 : 2,
				zIndex: Z.boss + 1,
			});
			for (const side of SIDES) {
				part(r, cam, b.x, b.y, b.angle, size * 0.3, side * size * 0.16, {
					w: size * 0.12,
					h: size * 0.12,
					circle: true,
					color: COLORS.detect,
					zIndex: Z.boss + 2,
				});
			}
		}
	}

	drawBullets(r: Renderer, cam: Camera, v: ViewRect, refs: GameRefs, opts: ActorDrawOpts): void {
		this.frameNo++;
		const byId = this.zombieById;
		byId.clear();
		let anyStuck = false;
		for (const b of refs.bullets) {
			if (b.stuckTo !== undefined) {
				anyStuck = true;
				break;
			}
		}
		if (anyStuck) {
			for (const zb of refs.zombies) byId.set(zb.id, zb);
		}
		const up = cam.screenDirToWorld(0, -1);
		for (const b of refs.bullets) {
			if (!circleInView(b.x, b.y, 90, v)) continue;
			if (b.fromPlayer && b.kind === "arrow") {
				const zb = b.stuckTo !== undefined ? byId.get(b.stuckTo) : undefined;
				if (zb !== undefined) {
					// stuck in a zombie: keeps its offset in the body's frame, turning (and jumping) with it
					let ref = this.stuckRef.get(b.id);
					if (ref === undefined) {
						ref = { a: zb.angleSlow, seen: this.frameNo };
						this.stuckRef.set(b.id, ref);
					}
					ref.seen = this.frameNo;
					const d = zb.angleSlow - ref.a;
					const ox = b.stuckDX ?? 0;
					const oy = b.stuckDY ?? 0;
					const lift = math.max(0, zb.jumpHeight ?? 0);
					const ax = zb.x + ox * math.cos(d) - oy * math.sin(d) + up.x * lift;
					const ay = zb.y + ox * math.sin(d) + oy * math.cos(d) + up.y * lift;
					const aa = b.angle + d;
					// only the back half sticks out of the body
					drawArrow(r, cam, ax - math.cos(aa) * 8, ay - math.sin(aa) * 8, aa, 1, Z.zombie + 4);
				} else if (b.grounded === true) {
					// lying on the ground, dimmed; the player walks over it to pick it up
					drawArrow(r, cam, b.x, b.y, b.angle, 0.6, Z.item);
				} else {
					drawArrow(r, cam, b.x, b.y, b.angle, 1, Z.projectile);
				}
				continue;
			}
			if (!b.fromPlayer) {
				if (b.targetX !== undefined && b.targetY !== undefined) {
					// spitter acid: a lobbed blob — shadow on the ground, blob arcing above it, and a
					// landing marker so the player can read where the puddle will appear
					const t = clamp(b.travel / math.max(1, b.range), 0, 1);
					const arc = math.sin(t * math.pi);
					const h = arc * math.min(70, 20 + b.range * 0.2);
					r.drawCircle(cam, b.targetX, b.targetY, SPIT_MARK_R * 2, {
						color: COLORS.acid,
						alpha: 0.08 + 0.12 * t,
						stroke: COLORS.acid,
						strokeThickness: 2,
						strokeAlpha: 0.3 + 0.5 * t,
						zIndex: Z.decal + 2,
					});
					r.drawCircle(cam, b.x, b.y, 12, { color: BLACK, alpha: 0.25, zIndex: Z.actorShadow });
					r.drawCircle(cam, b.x + up.x * h, b.y + up.y * h, 14 * (1 + 0.5 * arc), {
						color: COLORS.acid,
						stroke: COLORS.bloodZombie,
						strokeThickness: 2,
						zIndex: Z.projectile,
					});
				} else {
					// boss needle (any enemy shot without a landing point): a thin bone spike
					part(r, cam, b.x, b.y, b.angle, 0, 0, {
						w: 28,
						h: 3,
						color: COLORS.blade.Lerp(COLORS.parcel, 0.4),
						zIndex: Z.projectile,
					});
					part(r, cam, b.x, b.y, b.angle, 15, 0, {
						w: 6,
						h: 4,
						color: COLORS.boss,
						cornerRadius: 2,
						zIndex: Z.projectile + 1,
					});
				}
				continue;
			}
			if (b.kind === "fire") {
				r.drawCircle(cam, b.x, b.y, 12 + math.sin(opts.clock * 30 + b.id) * 3, {
					color: COLORS.campfire,
					alpha: 0.85,
					zIndex: Z.projectile,
				});
			} else if (b.kind === "electric") {
				part(r, cam, b.x, b.y, b.angle, 0, 0, {
					w: 14,
					h: 6,
					color: COLORS.uiBlue,
					cornerRadius: 3,
					zIndex: Z.projectile,
				});
			} else {
				part(r, cam, b.x, b.y, b.angle, 0, 0, {
					w: 16,
					h: 4,
					color: COLORS.bullet,
					cornerRadius: 2,
					zIndex: Z.projectile,
				});
			}
		}
		for (const [id, ref] of this.stuckRef) {
			if (ref.seen !== this.frameNo) this.stuckRef.delete(id);
		}
	}
}

/** arrow sprite (shaft, head, fletching) centred on (x, y) */
function drawArrow(r: Renderer, cam: Camera, x: number, y: number, a: number, alpha: number, z: number): void {
	part(r, cam, x, y, a, 0, 0, { w: 26, h: 3, color: COLORS.arrow, alpha, zIndex: z });
	part(r, cam, x, y, a, 14, 0, {
		w: 6,
		h: 6,
		color: COLORS.ironDoor,
		alpha,
		cornerRadius: 1,
		zIndex: z + 1,
	});
	part(r, cam, x, y, a, -12, 0, {
		w: 7,
		h: 7,
		color: COLORS.uiRed,
		alpha,
		cornerRadius: 1,
		zIndex: z + 1,
	});
}
