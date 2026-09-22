import { COLORS } from "shared/engine/colors";
import { DESIGN } from "shared/engine/constants";
import { WeaponKind } from "shared/data/kinds";
import { isChoppingTool, meleeReach, usesMagazine, WeaponDef, WEAPONS } from "shared/data/weapons";
import { angleDiff } from "shared/engine/vec2";
import { choose, damageCal, rndRange } from "shared/engine/rng";
import { currentWeapon, damageToPlayer, PlayerState } from "shared/game/player";
import { ownsWeapon } from "shared/game/save";
import { querySolids, Solid } from "shared/game/world";
import { blocksShots, PLAYER_RADIUS, raycast, rayCircle, segmentClear } from "shared/game/physics";
import { Bullet } from "shared/game/bullets";
import { BOSS1_SEGMENT_RADIUS, bossHitRadius, BossState, ZombieState, zombieRadius } from "shared/game/entities";
import { addPuddle, emitSound, reactToHit } from "./zombieAI";
import { hitMapItem } from "./interaction";
import { getCtx, refreshAim } from "../bootstrap";
import { GameRefs, SPEED_SCALE, Tracer } from "./types";

const DEG = math.pi / 180;

// knockback in px/frame @30fps (reaction_speed += …)
const KNOCK_BULLET = 3;
const KNOCK_ARROW = 1;
const KNOCK_FIRE = 1;
const KNOCK_MELEE = 6;
const KNOCK_HEADSHOT = 6;

/** gunfire noise ring (sound_view_shot(800)); the silencer divides it by 3 */
const SHOT_NOISE = 800;
const SILENCER_ID = 12;
const LASER_SIGHT_ID = 7;

/** obj_player_knife: attack_count_max 2 bodies per swing (the chainsaw is unlimited) */
const MELEE_MAX_TARGETS = 2;
/** weapon_angle_delay_time 5 frames: the blade stops briefly on impact (hit-stop) */
const HITSTOP = 5 / 30;

/** obj_bullet_arrow: 25 px/frame (40 with Robin Hood), losing 0.2 px/frame every frame */
const ARROW_SPEED = 25 * SPEED_SCALE;
const ARROW_SPEED_SKILL = 40 * SPEED_SCALE;
const ARROW_FRICTION = 0.2 * SPEED_SCALE * SPEED_SCALE;
const ARROW_GROUND_LIFE = 20;
const ARROW_PICKUP_DELAY = 1;

/** obj_bullet_fire: 20 px/frame, burns every body it overlaps */
const FIRE_SPEED = 20 * SPEED_SCALE;
const FIRE_RADIUS = 14;
/** fuel per shot: 0.1 oil (flamethrower) / 0.1 electricity (stun gun) */
const SPECIAL_FUEL_PER_SHOT = 0.1;

/** stun gun: nearest zombie inside ±40° and 400 px, then chains to two more */
const STUN_CONE = 40 * DEG;
const STUN_CHAINS = 2;

/** chainsaw: warm-up before it cuts (original 2.5 s, shortened), cools while idle, 3 oil/s */
const CHAINSAW_WARMUP = 1.5;
const CHAINSAW_MAX = 8;
const CHAINSAW_OIL_PER_SEC = 0.1 * 30;
const CHAINSAW_ARC = 25 * DEG;

/** turrets (obj_turret / obj_trap_electric): 0.67 s between shots, 200 px */
const TURRET_COOLDOWN = 20 / 30;
const TURRET_RANGE = 200;
const TURRET_DAMAGE = 25;
const SHOCK_DAMAGE = 10;

// --------------------------------------------------------------------------------------------
// ammo pools

function poolGet(refs: GameRefs, w: WeaponDef): number {
	const save = refs.save;
	if (w.id === 25 || w.id === 5) return save.oil;
	if (w.id === 26) return save.electric;
	const pool = w.ammoPool;
	if (pool === 1) return save.ammoNormal;
	if (pool === 2) return save.ammoShotgun;
	if (pool === 3) return save.ammoMachinegun;
	if (pool === 4) return save.ammoArrow;
	return save.oil;
}

function poolAdd(refs: GameRefs, w: WeaponDef, n: number): void {
	const save = refs.save;
	const pool = w.ammoPool;
	if (pool === 1) save.ammoNormal = math.max(0, save.ammoNormal + n);
	else if (pool === 2) save.ammoShotgun = math.max(0, save.ammoShotgun + n);
	else if (pool === 3) save.ammoMachinegun = math.max(0, save.ammoMachinegun + n);
	else if (pool === 4) save.ammoArrow = math.max(0, save.ammoArrow + n);
}

/** flamethrower / stun gun: their magazine refills for free, every shot burns 0.1 fuel */
function isFuelWeapon(w: WeaponDef): boolean {
	return w.id === 25 || w.id === 26;
}

function reloadTime(refs: GameRefs, w: WeaponDef): number {
	// "Quick reload": the original counts reload frames × (1 + level/4) → FASTER, not slower
	return w.reload / (1 + refs.save.skillLevels[4] / 4);
}

// --------------------------------------------------------------------------------------------
// shared hit helpers

function addTracer(refs: GameRefs, x1: number, y1: number, x2: number, y2: number, color: Color3, life = 0.2): void {
	const t: Tracer = { x1, y1, x2, y2, color, life };
	refs.tracers.push(t);
}

function shake(magnitude: number, duration: number): void {
	getCtx().cam.shake(magnitude, duration);
}

function hitZombie(refs: GameRefs, z: ZombieState, dmg: number, knock: number, blood = 3): void {
	const p = refs.player;
	const away = math.atan2(z.y - p.y, z.x - p.x);
	z.hp -= dmg;
	reactToHit(z, away, knock);
	if (blood > 0) refs.particles.bloodBurst(z.x, z.y, blood, "zombie", away);
}

function hitBoss(refs: GameRefs, b: BossState, dmg: number, x: number, y: number, blood = 3): void {
	b.hp -= dmg;
	b.hitFlash = 1;
	if (blood > 0) refs.particles.bloodBurst(x, y, blood);
}

/** obj_bullet headshot (skill "Head shooter"): shot within 2° of the body centre, 10% → +50% */
function headshot(refs: GameRefs, shotAngle: number, z: ZombieState, dmg: number): number {
	if (refs.save.skillLevels[19] <= 0) return 0;
	const p = refs.player;
	const toZ = math.atan2(z.y - p.y, z.x - p.x);
	if (math.abs(angleDiff(shotAngle, toZ)) >= 2 * DEG) return 0;
	if (math.random() * 100 >= 10) return 0;
	refs.particles.bloodBurst(z.x, z.y, 6);
	return math.floor(dmg / 2);
}

interface ShotHit {
	t: number;
	zombie?: ZombieState;
	boss?: BossState;
	solid?: Solid;
	x: number;
	y: number;
}

/** first thing on the ray: wall/tree/car, zombie body (circle) or boss body/segment */
function traceShot(refs: GameRefs, x0: number, y0: number, ang: number, range: number): ShotHit {
	const dx = math.cos(ang);
	const dy = math.sin(ang);
	const wall = raycast(refs.world, x0, y0, ang, range, blocksShots);
	let best = wall.dist;
	let zombie: ZombieState | undefined;
	let boss: BossState | undefined;
	for (const z of refs.zombies) {
		if (z.hp <= 0) continue;
		const t = rayCircle(x0, y0, dx, dy, z.x, z.y, zombieRadius(z));
		if (t !== undefined && t < best) {
			best = t;
			zombie = z;
		}
	}
	for (const b of refs.bosses) {
		if (b.hp <= 0) continue;
		if (b.type === 1 && b.bodyX !== undefined && b.bodyY !== undefined) {
			for (let i = 0; i < b.bodyX.size(); i += 2) {
				const t = rayCircle(x0, y0, dx, dy, b.bodyX[i], b.bodyY[i], BOSS1_SEGMENT_RADIUS);
				if (t !== undefined && t < best) {
					best = t;
					boss = b;
					zombie = undefined;
				}
			}
		} else {
			const t = rayCircle(x0, y0, dx, dy, b.x, b.y, bossHitRadius(b));
			if (t !== undefined && t < best) {
				best = t;
				boss = b;
				zombie = undefined;
			}
		}
	}
	if (boss !== undefined) zombie = undefined;
	const solid = zombie === undefined && boss === undefined ? wall.solid : undefined;
	return { t: best, zombie, boss, solid, x: x0 + dx * best, y: y0 + dy * best };
}

/** does a circle (x, y, r) touch a boss body? returns the contact point */
function bossContact(b: BossState, x: number, y: number, r: number): { x: number; y: number } | undefined {
	if (b.hp <= 0) return undefined;
	if (b.type === 1 && b.bodyX !== undefined && b.bodyY !== undefined) {
		for (let i = 0; i < b.bodyX.size(); i += 2) {
			const dx = b.bodyX[i] - x;
			const dy = b.bodyY[i] - y;
			const rr = BOSS1_SEGMENT_RADIUS + r;
			if (dx * dx + dy * dy < rr * rr) return { x: b.bodyX[i], y: b.bodyY[i] };
		}
		return undefined;
	}
	const rr = bossHitRadius(b) + r;
	const dx = b.x - x;
	const dy = b.y - y;
	if (dx * dx + dy * dy < rr * rr) return { x: b.x, y: b.y };
	return undefined;
}

// --------------------------------------------------------------------------------------------
// weapon switching

/** bumped by switchWeapon so the Combat instance drops its swing / bow / cadence state */
let switchSerial = 0;

/**
 * Equip another weapon mid-run. Called by main.client (backpack) and by the 1–5 hotkeys.
 * Rounds left in the old magazine go back to their pool, and reload / bow draw / recoil /
 * chainsaw warm-up / swing all reset — the new weapon starts EMPTY and reloads (switching no
 * longer hands out a free full magazine). Re-equipping the current weapon does nothing.
 */
export function switchWeapon(refs: GameRefs, weaponId: number): void {
	const w = WEAPONS[weaponId];
	if (w === undefined) return;
	const p = refs.player;
	const rt = p.weapon;
	if (rt.pointer === weaponId) {
		refs.save.equipWeapon = weaponId;
		return;
	}
	const old = currentWeapon(p);
	if (usesMagazine(old) && !isFuelWeapon(old) && rt.ammoCount > 0) {
		poolAdd(refs, old, rt.ammoCount);
	}
	rt.ammoCount = 0;
	rt.pointer = weaponId;
	rt.reloading = false;
	rt.reloadCount = 0;
	rt.reloadTotal = 0;
	rt.relaunchCount = 0;
	rt.autoReloadIdle = 0;
	rt.bowCount = 0;
	rt.angleRange = 0;
	rt.chainCount = 0;
	rt.scopeTime = 0;
	p.swingerActive = false;
	refs.save.equipWeapon = weaponId;
	switchSerial++;
}

/** weapons the survivor can pick with the number keys: owned ones (and the equipped one), by id */
function ownedWeapons(refs: GameRefs): Array<number> {
	const list: Array<number> = [];
	for (let i = 0; i < WEAPONS.size(); i++) {
		if (ownsWeapon(refs.save, i) || i === refs.player.weapon.pointer) list.push(i);
	}
	return list;
}

// --------------------------------------------------------------------------------------------

interface Swing {
	active: boolean;
	/** current blade angle relative to the aim, degrees (-limit → +limit) */
	angle: number;
	limit: number;
	/** weapon_angle_speed (deg/frame) — the `range` column of melee weapons */
	speed: number;
	reach: number;
	hits: number;
	delay: number;
	hitIds: Set<number>;
	solidIds: Set<number>;
}

export class Combat {
	/** seconds until the next shot/swing may start (weapon_relaunch_time_count) */
	private fireCd = 0;
	/** fractional fuel owed by the flamethrower / stun gun / chainsaw (paid in whole units) */
	private fuelDebt = 0;
	/** bow: seconds the string has been held */
	private drawTime = 0;
	private lastX: number | undefined;
	private lastY = 0;
	/** weapon_angle_range_move: extra spread from running (deg) */
	private moveSpread = 0;
	private swing: Swing = {
		active: false,
		angle: 0,
		limit: 0,
		speed: 0,
		reach: 0,
		hits: 0,
		delay: 0,
		hitIds: new Set<number>(),
		solidIds: new Set<number>(),
	};
	private turretCd = new Map<Solid, number>();
	private nearBuf: Array<Solid> = [];
	private zombieById = new Map<number, ZombieState>();

	/** last value of `switchSerial` this instance reacted to */
	private seenSwitch = 0;

	resetWeaponState(): void {
		this.fireCd = 0;
		this.drawTime = 0;
		this.swing.active = false;
		this.swing.hitIds.clear();
		this.swing.solidIds.clear();
	}

	// ---- reload -------------------------------------------------------------------------------

	private updateReload(refs: GameRefs, w: WeaponDef, dt: number): void {
		const rt = refs.player.weapon;
		const fuel = isFuelWeapon(w);
		const reserve = fuel ? (poolGet(refs, w) >= SPECIAL_FUEL_PER_SHOT ? 1 : 0) : poolGet(refs, w);
		if (!usesMagazine(w) || rt.ammoCount >= w.mag || reserve <= 0) {
			rt.reloading = false;
			rt.reloadCount = 0;
			rt.autoReloadIdle = 0;
			return;
		}
		// empty magazine or shotgun tube → reload right away; otherwise after 1 s idle or on R
		const want =
			rt.reloading ||
			refs.input.reloadPressed ||
			rt.ammoCount <= 0 ||
			w.kind === WeaponKind.Shotgun ||
			rt.autoReloadIdle >= 1;
		if (!want) {
			rt.autoReloadIdle += dt;
			return;
		}
		if (this.fireCd > 0) {
			// firing interrupts the reload: progress restarts (weapon_reload_time_count = 0)
			rt.reloading = false;
			rt.reloadCount = 0;
			return;
		}
		if (!rt.reloading) {
			rt.reloading = true;
			rt.reloadTotal = reloadTime(refs, w);
			rt.reloadCount = rt.reloadTotal;
		}
		rt.reloadCount -= dt;
		if (rt.reloadCount > 0) return;
		const want2 = w.kind === WeaponKind.Shotgun ? 1 : w.mag - rt.ammoCount;
		if (fuel) {
			rt.ammoCount = w.mag;
		} else {
			const take = math.max(0, math.min(want2, reserve));
			rt.ammoCount += take;
			poolAdd(refs, w, -take);
		}
		rt.reloading = false;
		rt.reloadCount = 0;
		rt.autoReloadIdle = 0;
	}

	// ---- guns ---------------------------------------------------------------------------------

	/** obj_bullet: spread = ±(basic + recoil + running) × one of a few ranges (laser / skill narrow it) */
	private spreadRoll(refs: GameRefs): number {
		const options: Array<number> = [1, 0.6];
		if (refs.save.skillLevels[5] > 0 || refs.save.equipGun === LASER_SIGHT_ID) options.push(0.4);
		if (refs.save.skillLevels[5] > 0 && refs.save.equipGun === LASER_SIGHT_ID) options.push(0.4);
		return rndRange(-1, 1) * choose(options);
	}

	private spendFuel(refs: GameRefs, w: WeaponDef, amount: number): boolean {
		const save = refs.save;
		const have = w.id === 26 ? save.electric : save.oil;
		if (have <= 0) return false;
		this.fuelDebt += amount;
		while (this.fuelDebt >= 1) {
			this.fuelDebt -= 1;
			if (w.id === 26) save.electric = math.max(0, save.electric - 1);
			else save.oil = math.max(0, save.oil - 1);
		}
		return true;
	}

	private fireGun(refs: GameRefs, w: WeaponDef, aim: number): void {
		const p = refs.player;
		const rt = p.weapon;
		if (rt.ammoCount <= 0) return;
		if (isFuelWeapon(w) && !this.spendFuel(refs, w, SPECIAL_FUEL_PER_SHOT)) return;
		rt.ammoCount--;
		rt.autoReloadIdle = 0;
		const baseSpread = w.cone + rt.angleRange + this.moveSpread;
		if (w.id === 25) {
			this.fireFlame(refs, w, aim, baseSpread);
		} else if (w.id === 26) {
			this.fireStun(refs, w, aim);
		} else if (w.kind === WeaponKind.Bow) {
			// crossbow: magazine weapon that shoots an arrow
			this.launchArrow(refs, w, aim, baseSpread);
		} else {
			const mx = p.x + math.cos(aim) * DESIGN.PLAYER_ARM;
			const my = p.y + math.sin(aim) * DESIGN.PLAYER_ARM;
			for (let i = 0; i < w.pellets; i++) {
				const a = aim + this.spreadRoll(refs) * baseSpread * DEG;
				const hit = traceShot(refs, p.x, p.y, a, w.range);
				const dmg = damageCal(w.dmg);
				if (hit.zombie !== undefined) {
					const extra = headshot(refs, a, hit.zombie, dmg);
					hitZombie(refs, hit.zombie, dmg + extra, KNOCK_BULLET + (extra > 0 ? KNOCK_HEADSHOT : 0));
				} else if (hit.boss !== undefined) {
					hitBoss(refs, hit.boss, dmg, hit.x, hit.y);
				} else if (hit.solid !== undefined) {
					refs.particles.debrisBurst(hit.x, hit.y, 2, COLORS.shadow);
					if (hit.solid.kind === "car" && hit.solid.tags === "car") hitMapItem(refs, hit.solid, false);
				}
				addTracer(refs, mx, my, hit.x, hit.y, COLORS.bullet);
			}
		}
		if (w.kind !== WeaponKind.Bow) {
			const loud = refs.save.equipGun === SILENCER_ID ? SHOT_NOISE / 3 : SHOT_NOISE;
			emitSound(refs, p.x, p.y, loud, true, true);
		}
		rt.angleRange = math.min(40, rt.angleRange + w.recoil);
		shake(w.recoil / 10 + 1, 0.08);
	}

	private fireFlame(refs: GameRefs, w: WeaponDef, aim: number, spread: number): void {
		const p = refs.player;
		const a = aim + this.spreadRoll(refs) * spread * DEG;
		const b: Bullet = {
			id: 200000 + math.random(1, 99999),
			x: p.x + math.cos(aim) * DESIGN.PLAYER_ARM,
			y: p.y + math.sin(aim) * DESIGN.PLAYER_ARM,
			angle: a,
			range: w.range,
			travel: 0,
			damage: w.dmg,
			speed: FIRE_SPEED,
			kind: "fire",
			alive: true,
			fromPlayer: true,
			alpha: 1,
			life: 1,
		};
		refs.bullets.push(b);
	}

	/** obj_bullet_electric: zap the nearest zombie in the cone, then chain to its neighbours */
	private fireStun(refs: GameRefs, w: WeaponDef, aim: number): void {
		const p = refs.player;
		const hitSet = new Set<number>();
		let fromX = p.x;
		let fromY = p.y;
		let cone = STUN_CONE;
		for (let jump = 0; jump <= STUN_CHAINS; jump++) {
			let best: ZombieState | undefined;
			let bestD = w.range;
			for (const z of refs.zombies) {
				if (z.hp <= 0 || hitSet.has(z.id)) continue;
				const d = math.sqrt((z.x - fromX) * (z.x - fromX) + (z.y - fromY) * (z.y - fromY));
				if (d >= bestD || d < 1) continue;
				if (jump === 0 && math.abs(angleDiff(aim, math.atan2(z.y - fromY, z.x - fromX))) > cone) continue;
				if (!segmentClear(refs.world, fromX, fromY, z.x, z.y, blocksShots)) continue;
				best = z;
				bestD = d;
			}
			if (best === undefined) {
				if (jump === 0) {
					// no zombie: zap a boss in the cone, or just crackle forward
					for (const b of refs.bosses) {
						const d = math.sqrt((b.x - p.x) * (b.x - p.x) + (b.y - p.y) * (b.y - p.y));
						if (
							d < w.range + bossHitRadius(b) &&
							math.abs(angleDiff(aim, math.atan2(b.y - p.y, b.x - p.x))) < cone
						) {
							hitBoss(refs, b, damageCal(w.dmg), b.x, b.y, 0);
							addTracer(refs, p.x, p.y, b.x, b.y, COLORS.uiBlue, 0.15);
							return;
						}
					}
					const miss = traceShot(refs, p.x, p.y, aim, w.range * 0.35);
					addTracer(refs, p.x, p.y, miss.x, miss.y, COLORS.uiBlue, 0.1);
				}
				return;
			}
			hitSet.add(best.id);
			best.hp -= damageCal(w.dmg);
			reactToHit(best, math.atan2(best.y - fromY, best.x - fromX), 0);
			addTracer(refs, fromX, fromY, best.x, best.y, COLORS.uiBlue, 0.15);
			fromX = best.x;
			fromY = best.y;
			cone = math.pi;
		}
	}

	/** player arrow (bow or crossbow): slows down, stops at its range, can be picked up again */
	private launchArrow(refs: GameRefs, w: WeaponDef, aim: number, spread: number): void {
		const p = refs.player;
		const robin = refs.save.skillLevels[6] > 0;
		const a = aim + this.spreadRoll(refs) * spread * (robin ? 0.5 : 1) * DEG;
		const b: Bullet = {
			id: 300000 + math.random(1, 99999),
			x: p.x + math.cos(aim) * DESIGN.PLAYER_ARM,
			y: p.y + math.sin(aim) * DESIGN.PLAYER_ARM,
			angle: a,
			range: w.range,
			travel: 0,
			damage: w.dmg,
			speed: robin ? ARROW_SPEED_SKILL : ARROW_SPEED,
			kind: "arrow",
			alive: true,
			fromPlayer: true,
			alpha: 1,
			life: ARROW_GROUND_LIFE,
			age: 0,
			friction: ARROW_FRICTION,
		};
		refs.bullets.push(b);
	}

	private updateBow(refs: GameRefs, w: WeaponDef, aim: number, held: boolean, released: boolean, dt: number): void {
		const p = refs.player;
		const rt = p.weapon;
		const drawNeeded = w.cooldown;
		if (held) {
			if (refs.save.ammoArrow > 0) this.drawTime += dt;
		}
		rt.bowCount = drawNeeded > 0 ? math.min(1, this.drawTime / drawNeeded) : 1;
		if (released) {
			// full draw fires; letting go early cancels the shot (no arrow spent)
			if (this.drawTime >= drawNeeded && this.fireCd <= 0 && refs.save.ammoArrow > 0) {
				refs.save.ammoArrow -= 1;
				this.launchArrow(refs, w, aim, w.cone + rt.angleRange + this.moveSpread);
				this.fireCd = w.cooldown;
				rt.autoReloadIdle = 0;
				shake(1, 0.05);
			}
			this.drawTime = 0;
			rt.bowCount = 0;
		} else if (!held) {
			this.drawTime = 0;
			rt.bowCount = 0;
		}
	}

	// ---- melee --------------------------------------------------------------------------------

	private startSwing(w: WeaponDef): void {
		const s = this.swing;
		s.active = true;
		s.limit = w.cone;
		s.angle = -w.cone;
		s.speed = math.max(1, w.range);
		s.reach = meleeReach(w);
		s.hits = 0;
		s.delay = 0;
		s.hitIds.clear();
		s.solidIds.clear();
	}

	/**
	 * obj_player_knife: the blade sweeps from −cone to +cone around the CURRENT aim with an
	 * ease-out speed; bodies inside the reach whose bearing the blade crosses this frame are hit
	 * (max 2 per swing), each hit pausing the blade for a few frames.
	 */
	private updateSwing(refs: GameRefs, w: WeaponDef, aim: number, dt: number): void {
		const s = this.swing;
		const p = refs.player;
		if (s.delay > 0) {
			s.delay -= dt;
		} else {
			const prev = s.angle;
			const step = s.speed * SPEED_SCALE * dt * (math.abs(s.angle - s.limit - 20) / 80);
			s.angle = math.min(s.limit + 1, s.angle + math.max(step, 0.5));
			this.sweep(refs, w, aim, prev, s.angle);
		}
		p.swingerActive = true;
		p.swingerAngle = aim + s.angle * DEG;
		p.swingReach = s.reach;
		if (s.angle > s.limit) {
			s.active = false;
			this.fireCd = math.max(this.fireCd, 0) + w.cooldown;
		}
	}

	private sweep(refs: GameRefs, w: WeaponDef, aim: number, fromDeg: number, toDeg: number): void {
		const s = this.swing;
		const p = refs.player;
		const bonus = 1 + refs.save.skillLevels[3] / 4;
		const knock = KNOCK_MELEE + refs.save.skillLevels[2] * 3;
		// zombies crossed by the blade this frame, in the order the blade meets them
		const crossed: Array<{ z: ZombieState; a: number }> = [];
		for (const z of refs.zombies) {
			if (z.hp <= 0 || s.hitIds.has(z.id)) continue;
			const dx = z.x - p.x;
			const dy = z.y - p.y;
			const d = math.sqrt(dx * dx + dy * dy);
			const zr = zombieRadius(z);
			if (d - zr > s.reach) continue;
			const rel = angleDiff(aim, math.atan2(dy, dx)) / DEG;
			const pad = d > zr ? math.deg(math.asin(zr / d)) : 90;
			if (rel + pad < fromDeg || rel - pad > toDeg) continue;
			crossed.push({ z, a: rel });
		}
		crossed.sort((a, b) => a.a < b.a);
		for (const c of crossed) {
			if (s.hits >= MELEE_MAX_TARGETS) break;
			s.hits++;
			s.hitIds.add(c.z.id);
			hitZombie(refs, c.z, math.floor(damageCal(w.dmg) * bonus), knock, 4);
			s.delay = HITSTOP;
			shake(2, 0.06);
		}
		// bosses (the original blade could not touch them)
		for (const b of refs.bosses) {
			if (s.hits >= MELEE_MAX_TARGETS || s.hitIds.has(-b.id)) continue;
			const tipAngle = aim + ((fromDeg + toDeg) / 2) * DEG;
			let touched: { x: number; y: number } | undefined;
			for (let k = 1; k <= 3 && touched === undefined; k++) {
				const dist = (s.reach * k) / 3;
				touched = bossContact(b, p.x + math.cos(tipAngle) * dist, p.y + math.sin(tipAngle) * dist, 8);
			}
			if (touched === undefined) continue;
			s.hits++;
			s.hitIds.add(-b.id);
			hitBoss(refs, b, math.floor(damageCal(w.dmg) * bonus), touched.x, touched.y, 4);
			s.delay = HITSTOP;
			shake(2, 0.06);
		}
		this.chopMapItems(refs, w, aim, fromDeg, toDeg, s.reach, false);
	}

	/** trees / cars / trash the blade passes over shake and may drop an item (once per swing) */
	private chopMapItems(
		refs: GameRefs,
		w: WeaponDef,
		aim: number,
		fromDeg: number,
		toDeg: number,
		reach: number,
		continuous: boolean,
	): void {
		const p = refs.player;
		const buf = this.nearBuf;
		buf.clear();
		querySolids(refs.world, p.x - reach - 8, p.y - reach - 8, p.x + reach + 8, p.y + reach + 8, buf);
		for (const s of buf) {
			if (s.kind !== "tree" && s.kind !== "car") continue;
			if (!continuous && this.swing.solidIds.has(s.id)) continue;
			const qx = math.clamp(p.x, s.x, s.x + s.w);
			const qy = math.clamp(p.y, s.y, s.y + s.h);
			const d = math.sqrt((qx - p.x) * (qx - p.x) + (qy - p.y) * (qy - p.y));
			if (d > reach) continue;
			const cx = s.x + s.w / 2;
			const cy = s.y + s.h / 2;
			const rel = angleDiff(aim, math.atan2(cy - p.y, cx - p.x)) / DEG;
			const half = math.max(s.w, s.h) / 2;
			const cd = math.max(1, math.sqrt((cx - p.x) * (cx - p.x) + (cy - p.y) * (cy - p.y)));
			const pad = cd > half ? math.deg(math.asin(half / cd)) : 90;
			if (rel + pad < fromDeg || rel - pad > toDeg) continue;
			if (!continuous) this.swing.solidIds.add(s.id);
			if (hitMapItem(refs, s, isChoppingTool(w))) {
				refs.particles.debrisBurst(qx, qy, 3, s.kind === "tree" ? COLORS.treeTrunk : COLORS.car);
				if (!continuous) shake(1.5, 0.05);
			}
		}
	}

	/** the chainsaw: hold to rev (warm-up), then it cuts everything in front continuously */
	private updateChainsaw(refs: GameRefs, w: WeaponDef, aim: number, held: boolean, dt: number): void {
		const p = refs.player;
		const rt = p.weapon;
		const fuelled = held && refs.save.oil > 0 && this.spendFuel(refs, w, CHAINSAW_OIL_PER_SEC * dt);
		if (fuelled) {
			rt.chainCount = math.min(CHAINSAW_MAX, rt.chainCount + dt);
		} else {
			rt.chainCount = math.max(0, rt.chainCount - dt);
		}
		const cutting = fuelled && rt.chainCount >= CHAINSAW_WARMUP;
		p.swingerActive = cutting;
		p.swingerAngle = aim;
		p.swingReach = meleeReach(w);
		if (!cutting) return;
		const reach = meleeReach(w);
		const bonus = 1 + refs.save.skillLevels[3] / 4;
		const knock = (KNOCK_MELEE + refs.save.skillLevels[2] * 3) * SPEED_SCALE * dt;
		let bit = false;
		for (const z of refs.zombies) {
			if (z.hp <= 0) continue;
			const dx = z.x - p.x;
			const dy = z.y - p.y;
			const d = math.sqrt(dx * dx + dy * dy);
			const zr = zombieRadius(z);
			if (d - zr > reach) continue;
			const pad = d > zr ? math.asin(zr / d) : math.pi / 2;
			if (math.abs(angleDiff(aim, math.atan2(dy, dx))) > CHAINSAW_ARC + pad) continue;
			// damage_cal(10) every frame of contact → per second
			hitZombie(refs, z, damageCal(w.dmg) * bonus * SPEED_SCALE * dt, knock, 0);
			if (math.random() < 6 * dt) refs.particles.bloodBurst(z.x, z.y, 2);
			bit = true;
		}
		for (const b of refs.bosses) {
			const tip = bossContact(
				b,
				p.x + math.cos(aim) * reach * 0.7,
				p.y + math.sin(aim) * reach * 0.7,
				reach * 0.3,
			);
			if (tip === undefined) continue;
			hitBoss(refs, b, damageCal(w.dmg) * bonus * SPEED_SCALE * dt, tip.x, tip.y, 0);
			bit = true;
		}
		if (bit) shake(1.5, 0.05);
		this.chopMapItems(refs, w, aim, -CHAINSAW_ARC / DEG, CHAINSAW_ARC / DEG, reach, true);
	}

	// ---- projectiles ----------------------------------------------------------------------------

	private groundArrow(b: Bullet): void {
		b.grounded = true;
		b.stuckTo = undefined;
		b.speed = 0;
		b.life = ARROW_GROUND_LIFE;
	}

	private updateArrow(refs: GameRefs, b: Bullet, dt: number): boolean {
		const p = refs.player;
		b.age = (b.age ?? 0) + dt;
		if (b.stuckTo !== undefined) {
			const z = this.zombieById.get(b.stuckTo);
			if (z !== undefined && z.hp > 0) {
				b.x = z.x + (b.stuckDX ?? 0);
				b.y = z.y + (b.stuckDY ?? 0);
				return false;
			}
			this.groundArrow(b);
		}
		if (b.grounded === true) {
			const dx = p.x - b.x;
			const dy = p.y - b.y;
			const pick = DESIGN.ITEM_GET_DISTANCE + 20;
			if ((b.age ?? 0) >= ARROW_PICKUP_DELAY && dx * dx + dy * dy < pick * pick) {
				refs.save.ammoArrow += 1;
				return true;
			}
			b.life -= dt;
			return b.life <= 0;
		}
		const step = b.speed * dt;
		b.speed = math.max(0, b.speed - (b.friction ?? 0) * dt);
		const hit = traceShot(refs, b.x, b.y, b.angle, math.min(step, math.max(0, b.range - b.travel)) + 0.01);
		if (hit.zombie !== undefined && hit.t <= step) {
			const z = hit.zombie;
			z.hp -= damageCal(b.damage);
			reactToHit(z, math.atan2(z.y - p.y, z.x - p.x), KNOCK_ARROW);
			refs.particles.bloodBurst(hit.x, hit.y, 3);
			b.stuckTo = z.id;
			b.stuckDX = (hit.x - z.x) * 0.5;
			b.stuckDY = (hit.y - z.y) * 0.5;
			b.speed = 0;
			b.x = hit.x;
			b.y = hit.y;
			return false;
		}
		if (hit.boss !== undefined && hit.t <= step) {
			hitBoss(refs, hit.boss, damageCal(b.damage), hit.x, hit.y);
			return true;
		}
		if (hit.solid !== undefined && hit.t <= step) {
			b.x = hit.x - math.cos(b.angle) * 2;
			b.y = hit.y - math.sin(b.angle) * 2;
			this.groundArrow(b);
			return false;
		}
		b.x += math.cos(b.angle) * step;
		b.y += math.sin(b.angle) * step;
		b.travel += step;
		if (b.travel >= b.range || b.speed <= 1) this.groundArrow(b);
		return false;
	}

	private updateFire(refs: GameRefs, b: Bullet, dt: number): boolean {
		const p = refs.player;
		const step = b.speed * dt;
		const wall = raycast(refs.world, b.x, b.y, b.angle, step, blocksShots);
		b.x += math.cos(b.angle) * wall.dist;
		b.y += math.sin(b.angle) * wall.dist;
		b.travel += wall.dist;
		b.life -= dt;
		const tick = SPEED_SCALE * dt;
		for (const z of refs.zombies) {
			if (z.hp <= 0) continue;
			const rr = zombieRadius(z) + FIRE_RADIUS;
			const dx = z.x - b.x;
			const dy = z.y - b.y;
			if (dx * dx + dy * dy > rr * rr) continue;
			z.hp -= damageCal(b.damage) * tick;
			reactToHit(z, math.atan2(z.y - p.y, z.x - p.x), KNOCK_FIRE * tick);
		}
		for (const boss of refs.bosses) {
			const c = bossContact(boss, b.x, b.y, FIRE_RADIUS);
			if (c !== undefined) hitBoss(refs, boss, damageCal(b.damage) * tick, b.x, b.y, 0);
		}
		return wall.solid !== undefined || b.travel >= b.range || b.life <= 0;
	}

	private updateEnemyShot(refs: GameRefs, b: Bullet, dt: number): boolean {
		const p = refs.player;
		const step = b.speed * dt;
		b.life -= dt;
		if (b.targetX !== undefined && b.targetY !== undefined) {
			// spitter acid: flies to the predicted point (or 1 s, or a wall) and becomes a puddle
			const rem = math.max(0, b.range - b.travel);
			const wall = raycast(refs.world, b.x, b.y, b.angle, math.min(step, rem));
			const adv = wall.dist;
			b.x += math.cos(b.angle) * adv;
			b.y += math.sin(b.angle) * adv;
			b.travel += adv;
			if (wall.solid !== undefined || b.travel >= b.range - 1 || b.life <= 0) {
				addPuddle(refs, b.x, b.y);
				return true;
			}
			return false;
		}
		// boss needle
		const wall = raycast(refs.world, b.x, b.y, b.angle, step);
		b.x += math.cos(b.angle) * wall.dist;
		b.y += math.sin(b.angle) * wall.dist;
		b.travel += wall.dist;
		const dx = p.x - b.x;
		const dy = p.y - b.y;
		const rr = PLAYER_RADIUS + 6;
		if (dx * dx + dy * dy < rr * rr) {
			if (damageToPlayer(p, refs.save, b.damage)) {
				// pushed along the needle's flight (the old code threw the player back at the boss)
				p.reactionDir = b.angle;
				refs.particles.bloodBurst(p.x, p.y, 3, "player");
			}
			return true;
		}
		return wall.solid !== undefined || b.travel >= b.range || b.life <= 0;
	}

	private updateBullets(refs: GameRefs, dt: number): void {
		this.zombieById.clear();
		for (const z of refs.zombies) this.zombieById.set(z.id, z);
		for (let i = refs.bullets.size() - 1; i >= 0; i--) {
			const b = refs.bullets[i];
			let dead = !b.alive;
			if (!dead) {
				if (!b.fromPlayer) {
					dead = this.updateEnemyShot(refs, b, dt);
				} else if (b.kind === "arrow") {
					dead = this.updateArrow(refs, b, dt);
				} else if (b.kind === "fire") {
					dead = this.updateFire(refs, b, dt);
				} else {
					b.life -= dt;
					dead = b.life <= 0;
				}
			}
			if (dead) {
				b.alive = false;
				refs.bullets.remove(i);
			}
		}
	}

	// ---- constructions that shoot ----------------------------------------------------------------

	private updateTurrets(refs: GameRefs, dt: number): void {
		const p = refs.player;
		const buf = this.nearBuf;
		buf.clear();
		querySolids(refs.world, p.x - 1400, p.y - 1400, p.x + 1400, p.y + 1400, buf);
		for (const s of buf) {
			const electric = s.tags === "electric_turret";
			if (!electric && s.tags !== "turret" && s.tags !== "turret_drone") continue;
			let cd = (this.turretCd.get(s) ?? 0) - dt;
			if (cd <= 0) {
				const cx = s.x + s.w / 2;
				const cy = s.y + s.h / 2;
				let target: ZombieState | undefined;
				let bestD = TURRET_RANGE;
				for (const z of refs.zombies) {
					if (z.hp <= 0) continue;
					const d = math.sqrt((z.x - cx) * (z.x - cx) + (z.y - cy) * (z.y - cy));
					if (d < bestD && segmentClear(refs.world, cx, cy, z.x, z.y, blocksShots)) {
						bestD = d;
						target = z;
					}
				}
				if (target !== undefined) {
					cd = TURRET_COOLDOWN;
					const ang = math.atan2(target.y - cy, target.x - cx);
					if (electric) {
						target.hp -= damageCal(SHOCK_DAMAGE);
						reactToHit(target, ang, 0, 0.4);
						addTracer(refs, cx, cy, target.x, target.y, COLORS.uiBlue, 0.12);
					} else {
						const a = ang + rndRange(-1, 1) * 10 * DEG;
						const hit = traceShot(refs, cx, cy, a, TURRET_RANGE);
						const dmg = damageCal(TURRET_DAMAGE * (1 + refs.save.skillLevels[13] / 2));
						if (hit.zombie !== undefined) hitZombie(refs, hit.zombie, dmg, KNOCK_BULLET);
						else if (hit.boss !== undefined) hitBoss(refs, hit.boss, dmg, hit.x, hit.y);
						addTracer(refs, cx, cy, hit.x, hit.y, COLORS.bullet);
					}
				} else {
					cd = 0.15;
				}
			}
			this.turretCd.set(s, cd);
		}
		for (const [s] of this.turretCd) {
			if (s.removed === true) this.turretCd.delete(s);
		}
	}

	private decayTracers(refs: GameRefs, dt: number): void {
		for (let i = refs.tracers.size() - 1; i >= 0; i--) {
			refs.tracers[i].life -= dt;
			if (refs.tracers[i].life <= 0) refs.tracers.remove(i);
		}
	}

	private trackMovement(p: PlayerState, dt: number, noPenalty: boolean): void {
		if (this.lastX !== undefined && dt > 0) {
			const moved = math.sqrt((p.x - this.lastX) * (p.x - this.lastX) + (p.y - this.lastY) * (p.y - this.lastY));
			// weapon_angle_range_move = distance moved per frame / 4 (deg); "Move shooting" removes it
			const perFrame = moved / (dt * SPEED_SCALE);
			this.moveSpread = noPenalty || perFrame > 60 ? 0 : perFrame / 4;
		}
		this.lastX = p.x;
		this.lastY = p.y;
	}

	private recoverRecoil(refs: GameRefs, dt: number): void {
		const rt = refs.player.weapon;
		if (rt.angleRange <= 0) return;
		// quadratic settle like the original (faster when calm), plus a small linear floor
		const k = refs.player.buffs.calm > 0 ? 5 : 7;
		const con = 0.1 * ((rt.angleRange * rt.angleRange) / k) * SPEED_SCALE * dt + 2 * dt;
		rt.angleRange = rt.angleRange <= con ? 0 : rt.angleRange - con;
	}

	update(refs: GameRefs, dt: number): void {
		const p = refs.player;
		const input = refs.input;
		this.decayTracers(refs, dt);
		p.hitFlash = math.max(0, (p.hitFlash ?? 0) - dt);
		// aim from the PLAYER's position every frame, not only when the mouse moves
		p.angle = refreshAim(p.x, p.y);
		const aim = p.angle;
		this.trackMovement(p, dt, refs.save.skillLevels[18] > 0);
		this.updateBullets(refs, dt);
		this.updateTurrets(refs, dt);

		if (input.weaponSlotPressed >= 0 && refs.pendingPlace < 0) {
			const list = ownedWeapons(refs);
			const id = list[input.weaponSlotPressed];
			if (id !== undefined) switchWeapon(refs, id);
		}

		if (this.seenSwitch !== switchSerial) {
			this.seenSwitch = switchSerial;
			this.resetWeaponState();
		}
		const w = currentWeapon(p);
		const rt = p.weapon;
		this.fireCd = math.max(this.fireCd - dt, -dt);
		this.recoverRecoil(refs, dt);

		if (refs.pendingPlace >= 0 || p.dead) {
			this.swing.active = false;
			this.drawTime = 0;
			p.swingerActive = false;
			return;
		}

		const blocked = input.attackBlocked;
		const held = input.attackHeld && !blocked;
		const pressed = input.attackPressed && !blocked;
		const released = input.attackReleased && !blocked;

		this.updateReload(refs, w, dt);

		if (w.id === 5) {
			this.updateChainsaw(refs, w, aim, held, dt);
			return;
		}
		if (w.kind === WeaponKind.Melee) {
			rt.chainCount = 0;
			if (this.swing.active) {
				this.updateSwing(refs, w, aim, dt);
			} else {
				p.swingerActive = false;
				// every blade attacks continuously while the button is held
				if ((held || pressed) && this.fireCd <= 0) {
					this.startSwing(w);
					this.updateSwing(refs, w, aim, dt);
				}
			}
			return;
		}
		p.swingerActive = false;

		if (w.kind === WeaponKind.Bow && w.id !== 23) {
			this.updateBow(refs, w, aim, held, released, dt);
			return;
		}

		if (w.kind === WeaponKind.Sniper) {
			rt.scopeTime = held ? rt.scopeTime + dt : 0;
			// bolt action fires when the button is released (after aiming); the semi-auto also while held
			const want = released || (w.auto && held);
			if (want && this.fireCd <= 0 && rt.ammoCount > 0) {
				this.fireGun(refs, w, aim);
				this.fireCd += w.cooldown;
			}
			return;
		}

		// rifles, pistols, MGs, shotguns, crossbow, flamethrower, stun gun
		const want = w.auto ? held || pressed : pressed;
		let shots = 0;
		while (want && this.fireCd <= 0 && rt.ammoCount > 0 && shots < 3) {
			this.fireGun(refs, w, aim);
			this.fireCd += math.max(w.cooldown, 1 / 60);
			shots++;
			if (!w.auto) break;
		}
	}
}
