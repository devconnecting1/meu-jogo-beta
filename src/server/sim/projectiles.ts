//!native
/*
 * Projectiles in flight, on the server (docs/MULTIPLAYER.md §3.1 step 2 "projéteis, explosões e poças",
 * §2.3, §4.1 Fx). SERVER ONLY, and pure: no Instances, no services.
 *
 * Why this file had to exist for F2 to be finishable. `server/sim/combat.ts` resolves hitscan itself, but a
 * bow and a flamethrower do not fire a ray — they ASK for a projectile through `CombatHooks.projectile` and
 * let the world fly it. On the other side, the spitter and the needle boss push their shots straight into
 * `refs.bullets` from the shared brains. Until something stepped those lists, phase 2 would have had a bow
 * that shoots nothing, a flamethrower that burns nothing and acid blobs hanging in the air for ever — the
 * same class of hole as a horde that bites for zero.
 *
 * Who decides what:
 *   - the FLIGHT is here: speed, friction, walls, range, what the body touches;
 *   - the DAMAGE to a zombie or a boss goes back through `ServerCombat` (`hitZombieWith`/`hitBossWith`), so
 *     an arrow pays the same XP and leaves the same assist trail as a rifle round;
 *   - the DAMAGE to a survivor goes through `Ctx.hurtPlayer`, which is the horde's injected sink, so a
 *     needle costs exactly what a bite costs (§2.3, MP-00);
 *   - the DRAWING is the client's: every launch and every end is announced on the Fx channel (§4.2
 *     `ProjSpawn` / `ProjEnd`), and the client flies nothing of its own in phase 2.
 *
 * The numbers are the ones the single-player loop used (client/systems/combat.ts), unchanged.
 */
import { WeaponKind } from "shared/data/kinds";
import { damageCal } from "shared/engine/rng";
import { Bullet } from "shared/game/bullets";
import { BOSS1_SEGMENT_RADIUS, BossState, bossHitRadius, ZombieState, zombieRadius } from "shared/game/entities";
import { PLAYER_RADIUS, blocksShots, raycast } from "shared/game/physics";
import { SLOT_NONE } from "shared/net/mpConfig";
import * as Net from "shared/net/protocol";
import { SPEED_SCALE } from "shared/sim/types";
import * as Ctx from "shared/sim/ai/context";
import { addPuddle, reactToHit } from "shared/sim/ai/zombieBrain";
import { ProjectileRequest, ServerCombat } from "./combat";
import { ServerPlayer } from "./players";

/** knockback in px/frame @30fps, the original's `reaction_speed +=` for these two */
const KNOCK_ARROW = 1;
const KNOCK_FIRE = 1;
/** a flame is a moving disc, not a ray: this is its radius */
const FIRE_RADIUS = 14;
/** a needle hits a survivor at this distance from their centre */
const NEEDLE_RADIUS = 6;
/** an arrow that stopped lies on the ground this long before it is gone (F3 makes it pickable again) */
const ARROW_GROUND_LIFE = 20;
/** below this speed an arrow has stopped being a projectile */
const ARROW_MIN_SPEED = 1;
/**
 * Live projectiles the server will fly. A flood of them is a bug, not a play style, and the oldest is the
 * one worth dropping: whatever it was going to hit, it has been in the air the longest.
 */
const MAX_PROJECTILES = 256;

/** what the Fx channel calls this projectile; a u16 handle, because a Bullet id can be negative (§4.2) */
interface Tracked {
	projId: number;
	/** the survivor that fired it, or SLOT_NONE for a zombie's or a boss's shot */
	owner: number;
}

export interface ProjectileWorld {
	/** the survivor of a slot, or undefined once they have left (their projectiles stop paying anyone) */
	playerOf: (slot: number) => ServerPlayer | undefined;
	/** where the damage is decided; without it nothing is hurt and the shots are pure cosmetics */
	combat?: ServerCombat;
	/** one cosmetic event for the Fx channel (§4.1) */
	onFx?: (event: Net.FxEvent) => void;
}

/**
 * Every projectile of the server, in `refs.bullets` — the same array the brains push their shots into and
 * the same one `AiRefs` hands around, so there is one list of things in the air, not two.
 */
export class ServerProjectiles {
	/**
	 * Where the damage is decided. It is set after construction because the two are mutually dependent —
	 * combat asks this module to fly a projectile, and this module asks combat what the hit costs.
	 */
	combat?: ServerCombat;

	private readonly tracked = new Map<number, Tracked>();
	private nextProjId = 1;

	constructor(private readonly world: ProjectileWorld) {
		this.combat = world.combat;
	}

	/** `CombatHooks.projectile`: a weapon asked the world to fly something (§2.3) */
	launch(refs: Ctx.AiRefs, request: ProjectileRequest): void {
		const arrow = request.kind === Net.ProjKind.Arrow;
		const bullet: Bullet = {
			// a negative id keeps a player's projectile out of the brains' own id space (spitter blobs and
			// boss needles are negative too, but they never look each other up)
			id: -(1 + this.nextProjId),
			x: request.x,
			y: request.y,
			angle: request.angle,
			range: request.range,
			travel: 0,
			damage: request.damage,
			speed: request.speed,
			kind: arrow ? "arrow" : request.kind === Net.ProjKind.Electric ? "electric" : "fire",
			alive: true,
			fromPlayer: true,
			alpha: 1,
			life: arrow ? ARROW_GROUND_LIFE : request.range / math.max(1, request.speed),
			age: 0,
			friction: request.friction,
		};
		refs.bullets.push(bullet);
		this.announce(bullet, request.kind, request.ownerSlot);
		this.trim(refs);
	}

	/**
	 * One tick of everything in the air. Runs in the world half of the tick, after the zombies and the
	 * bosses moved, so a flame burns the body where it ENDED the tick rather than where it started it.
	 */
	step(refs: Ctx.AiRefs, dt: number): void {
		const bullets = refs.bullets;
		for (let i = bullets.size() - 1; i >= 0; i--) {
			const b = bullets[i];
			let dead = !b.alive;
			if (!dead) {
				if (!b.fromPlayer) {
					dead = this.stepEnemyShot(refs, b, dt);
				} else if (b.kind === "arrow") {
					dead = this.stepArrow(refs, b, dt);
				} else if (b.kind === "fire" || b.kind === "electric") {
					dead = this.stepFire(refs, b, dt);
				} else {
					// a hitscan bullet has no flight: combat already resolved it, this is only its trail
					b.life -= dt;
					dead = b.life <= 0;
				}
			}
			if (!dead) continue;
			b.alive = false;
			this.retire(b, Net.ProjEndHow.Fell);
			bullets.remove(i);
		}
		// the brains push their own shots into the same list: whatever appeared this tick still has to be
		// announced, or the client would have nothing to draw between the spit and the puddle
		for (const b of bullets) {
			if (this.tracked.has(b.id)) continue;
			this.announce(b, b.targetX !== undefined ? Net.ProjKind.Spit : Net.ProjKind.Needle, SLOT_NONE);
		}
		this.trim(refs);
	}

	/** live projectiles (§12.2 and the tests) */
	count(): number {
		return this.tracked.size();
	}

	// ---------------------------------------------------------------- one projectile

	/** spitter acid (becomes a puddle where it lands) and boss needles (hurt the first survivor they reach) */
	private stepEnemyShot(refs: Ctx.AiRefs, b: Bullet, dt: number): boolean {
		const step = b.speed * dt;
		b.life -= dt;
		if (b.targetX !== undefined && b.targetY !== undefined) {
			const rem = math.max(0, b.range - b.travel);
			const wall = raycast(refs.world, b.x, b.y, b.angle, math.min(step, rem));
			b.x += math.cos(b.angle) * wall.dist;
			b.y += math.sin(b.angle) * wall.dist;
			b.travel += wall.dist;
			if (wall.solid !== undefined || b.travel >= b.range - 1 || b.life <= 0) {
				addPuddle(refs, b.x, b.y);
				return true;
			}
			return false;
		}
		const wall = raycast(refs.world, b.x, b.y, b.angle, step);
		// the ray's answer is one shared table (physics.ts, F4): take what is needed from it before anything else runs
		const blocked = wall.solid !== undefined;
		b.x += math.cos(b.angle) * wall.dist;
		b.y += math.sin(b.angle) * wall.dist;
		b.travel += wall.dist;
		const rr = PLAYER_RADIUS + NEEDLE_RADIUS;
		for (const p of refs.players) {
			const dx = p.x - b.x;
			const dy = p.y - b.y;
			if (dx * dx + dy * dy >= rr * rr) continue;
			if (Ctx.hurtPlayer(refs, p, refs.saveOf(p), b.damage)) {
				// pushed ALONG the needle's flight (the original threw the survivor back at the boss)
				p.reactionDir = b.angle;
				Ctx.fxBlood(refs, p.x, p.y, 3, "player", b.angle);
			}
			return true;
		}
		return blocked || b.travel >= b.range || b.life <= 0;
	}

	/** an arrow flies, slows down, sticks in what it hits and lies where it stopped */
	private stepArrow(refs: Ctx.AiRefs, b: Bullet, dt: number): boolean {
		b.age = (b.age ?? 0) + dt;
		if (b.stuckTo !== undefined) {
			const z = this.zombieById(refs, b.stuckTo);
			if (z !== undefined && z.hp > 0) {
				b.x = z.x + (b.stuckDX ?? 0);
				b.y = z.y + (b.stuckDY ?? 0);
				return false;
			}
			return this.ground(b);
		}
		if (b.grounded === true) {
			// picking it back up is F3's (the inventory is not authoritative yet): here it simply rots
			b.life -= dt;
			return b.life <= 0;
		}
		const step = b.speed * dt;
		b.speed = math.max(0, b.speed - (b.friction ?? 0) * dt);
		const reach = math.min(step, math.max(0, b.range - b.travel)) + 0.01;
		const wall = raycast(refs.world, b.x, b.y, b.angle, reach, blocksShots);
		// one shared table (physics.ts, F4): copied before the hits below get a chance to cast rays of their own
		const wallDist = wall.dist;
		const wallHit = wall.solid !== undefined;
		const travel = math.min(step, wallDist);
		const nx = b.x + math.cos(b.angle) * travel;
		const ny = b.y + math.sin(b.angle) * travel;
		const sp = this.ownerOf(b);
		const z = this.zombieAt(refs, nx, ny, 0);
		if (z !== undefined) {
			const damage = damageCal(b.damage);
			const away = math.atan2(z.y - b.y, z.x - b.x);
			// an arrow is a bow's kill whatever is in hand when it lands (CON-04, Bow expert)
			if (sp !== undefined) this.combat?.hitZombieWith(sp, z, damage, KNOCK_ARROW, 0, away, WeaponKind.Bow);
			else this.hitWithoutOwner(z, damage, away, KNOCK_ARROW);
			b.stuckTo = z.id;
			b.stuckDX = (nx - z.x) * 0.5;
			b.stuckDY = (ny - z.y) * 0.5;
			b.speed = 0;
			b.x = nx;
			b.y = ny;
			return false;
		}
		const boss = this.bossAt(refs, nx, ny, 0);
		if (boss !== undefined) {
			if (sp !== undefined) this.combat?.hitBossWith(sp, boss, damageCal(b.damage), nx, ny);
			return true;
		}
		b.x = nx;
		b.y = ny;
		b.travel += travel;
		if (wallHit && wallDist <= step) {
			// stop just short of the wall, so the shaft is drawn in the street and not inside the bricks
			b.x -= math.cos(b.angle) * 2;
			b.y -= math.sin(b.angle) * 2;
			return this.ground(b);
		}
		if (b.travel >= b.range || b.speed <= ARROW_MIN_SPEED) return this.ground(b);
		return false;
	}

	/** a flame (or the stun gun's arc) is a short-lived disc that burns everything it passes through */
	private stepFire(refs: Ctx.AiRefs, b: Bullet, dt: number): boolean {
		const step = b.speed * dt;
		const wall = raycast(refs.world, b.x, b.y, b.angle, step, blocksShots);
		// one shared table (physics.ts, F4): read before the burns below, which may cast rays of their own
		const blocked = wall.solid !== undefined;
		b.x += math.cos(b.angle) * wall.dist;
		b.y += math.sin(b.angle) * wall.dist;
		b.travel += wall.dist;
		b.life -= dt;
		// the flame's damage is per second of contact, so it is paid by the tick, exactly as before F2
		const tick = SPEED_SCALE * dt;
		const sp = this.ownerOf(b);
		for (const z of refs.zombies) {
			if (z.hp <= 0) continue;
			const rr = zombieRadius(z) + FIRE_RADIUS;
			const dx = z.x - b.x;
			const dy = z.y - b.y;
			if (dx * dx + dy * dy > rr * rr) continue;
			const damage = damageCal(b.damage) * tick;
			const away = math.atan2(z.y - b.y, z.x - b.x);
			if (sp !== undefined) {
				this.combat?.hitZombieWith(sp, z, damage, KNOCK_FIRE * tick, 0, away, WeaponKind.Special);
			} else {
				this.hitWithoutOwner(z, damage, away, KNOCK_FIRE * tick);
			}
		}
		const boss = this.bossAt(refs, b.x, b.y, FIRE_RADIUS);
		if (boss !== undefined && sp !== undefined) {
			this.combat?.hitBossWith(sp, boss, damageCal(b.damage) * tick, b.x, b.y);
		}
		return blocked || b.travel >= b.range || b.life <= 0;
	}

	// ---------------------------------------------------------------- helpers

	private ground(b: Bullet): boolean {
		b.grounded = true;
		b.speed = 0;
		b.life = ARROW_GROUND_LIFE;
		return false;
	}

	private ownerOf(b: Bullet): ServerPlayer | undefined {
		const rec = this.tracked.get(b.id);
		if (rec === undefined || rec.owner === SLOT_NONE) return undefined;
		return this.world.playerOf(rec.owner);
	}

	/** the shooter left mid-flight: the shot still lands, it just credits nobody (§3.6 pays a survivor) */
	private hitWithoutOwner(z: ZombieState, damage: number, away: number, knock: number): void {
		z.hp -= damage;
		reactToHit(z, away, knock);
	}

	private zombieById(refs: Ctx.AiRefs, id: number): ZombieState | undefined {
		for (const z of refs.zombies) {
			if (z.id === id) return z;
		}
		return undefined;
	}

	private zombieAt(refs: Ctx.AiRefs, x: number, y: number, margin: number): ZombieState | undefined {
		for (const z of refs.zombies) {
			if (z.hp <= 0) continue;
			const rr = zombieRadius(z) + margin;
			const dx = z.x - x;
			const dy = z.y - y;
			if (dx * dx + dy * dy <= rr * rr) return z;
		}
		return undefined;
	}

	private bossAt(refs: Ctx.AiRefs, x: number, y: number, margin: number): BossState | undefined {
		for (const b of refs.bosses) {
			if (b.hp <= 0) continue;
			const bodyX = b.bodyX;
			const bodyY = b.bodyY;
			if (b.type === 1 && bodyX !== undefined && bodyY !== undefined) {
				const rr = BOSS1_SEGMENT_RADIUS + margin;
				for (let i = 0; i < bodyX.size(); i += 2) {
					const dx = bodyX[i] - x;
					const dy = bodyY[i] - y;
					if (dx * dx + dy * dy < rr * rr) return b;
				}
				continue;
			}
			const rr = bossHitRadius(b) + margin;
			const dx = b.x - x;
			const dy = b.y - y;
			if (dx * dx + dy * dy < rr * rr) return b;
		}
		return undefined;
	}

	/** gives a projectile its wire handle and tells the clients it exists (§4.2 ProjSpawn) */
	private announce(b: Bullet, kind: number, owner: number): void {
		const projId = this.nextProjId;
		this.nextProjId = (this.nextProjId % 65535) + 1;
		this.tracked.set(b.id, { projId, owner });
		this.world.onFx?.({
			t: Net.FxType.ProjSpawn,
			projId,
			kind,
			owner,
			x: b.x,
			y: b.y,
			angle: b.angle,
			speed: b.speed,
		});
	}

	private retire(b: Bullet, how: number): void {
		const rec = this.tracked.get(b.id);
		if (rec === undefined) return;
		this.tracked.delete(b.id);
		this.world.onFx?.({ t: Net.FxType.ProjEnd, projId: rec.projId, x: b.x, y: b.y, how });
	}

	/** nothing in this world may grow without a ceiling, however odd the reason it grew */
	private trim(refs: Ctx.AiRefs): void {
		while (refs.bullets.size() > MAX_PROJECTILES) {
			const b = refs.bullets[0];
			this.retire(b, Net.ProjEndHow.Fell);
			refs.bullets.remove(0);
		}
	}
}
