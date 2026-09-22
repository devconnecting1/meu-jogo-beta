import { COLORS } from "shared/engine/colors";
import { WeaponKind } from "shared/data/kinds";
import { WeaponDef, WEAPONS } from "shared/data/weapons";
import { angleDiff, radToDeg } from "shared/engine/vec2";
import { chance, damageCal } from "shared/engine/rng";
import { currentWeapon, damageToPlayer } from "shared/game/player";
import { pointInSolid } from "shared/game/world";
import { Bullet } from "shared/game/bullets";
import { ZombieState } from "shared/game/entities";
import { applyKnockback } from "./zombieAI";
import { GameRefs, Tracer } from "./types";

const DEG = math.pi / 180;
const HIT_RADIUS = 18;

function poolGet(refs: GameRefs, pool: number): number {
	const save = refs.save;
	if (pool === 1) return save.ammoNormal;
	if (pool === 2) return save.ammoShotgun;
	if (pool === 3) return save.ammoMachinegun;
	if (pool === 4) return save.ammoArrow;
	if (pool === 5) return save.oil;
	return save.electric;
}

function poolSpend(refs: GameRefs, pool: number, n: number): void {
	const save = refs.save;
	if (pool === 1) save.ammoNormal = math.max(0, save.ammoNormal - n);
	else if (pool === 2) save.ammoShotgun = math.max(0, save.ammoShotgun - n);
	else if (pool === 3) save.ammoMachinegun = math.max(0, save.ammoMachinegun - n);
	else if (pool === 4) save.ammoArrow = math.max(0, save.ammoArrow - n);
	else if (pool === 5) save.oil = math.max(0, save.oil - n);
	else save.electric = math.max(0, save.electric - n);
}

function spendSpecial(refs: GameRefs, w: WeaponDef): boolean {
	if (w.id === 25) {
		if (refs.save.oil <= 0) return false;
		refs.save.oil--;
		return true;
	}
	if (w.id === 26) {
		if (refs.save.electric <= 0) return false;
		refs.save.electric--;
		return true;
	}
	return true;
}

function addTracer(refs: GameRefs, x1: number, y1: number, x2: number, y2: number, color: Color3): void {
	const t: Tracer = { x1, y1, x2, y2, color, life: 0.2 };
	refs.tracers.push(t);
}

function headshot(refs: GameRefs, shotAngle: number, z: ZombieState): boolean {
	if (refs.save.skillLevels[19] <= 0) return false;
	const toZ = math.atan2(z.y - refs.player.y, z.x - refs.player.x);
	if (math.abs(radToDeg(angleDiff(shotAngle, toZ))) >= 2) return false;
	return chance(10);
}

function damageZombie(refs: GameRefs, z: ZombieState, base: number, shotAngle: number): void {
	let dmg = base;
	if (headshot(refs, shotAngle, z)) {
		dmg = math.floor(dmg * 1.5);
	}
	z.hp -= dmg;
}

function resolveHitscan(
	refs: GameRefs,
	x0: number,
	y0: number,
	angle: number,
	range: number,
	damage: number,
	color: Color3,
): void {
	const dx = math.cos(angle);
	const dy = math.sin(angle);
	let hx = x0 + dx * range;
	let hy = y0 + dy * range;
	const step = 10;
	for (let t = step; t <= range; t += step) {
		const px = x0 + dx * t;
		const py = y0 + dy * t;
		const solid = pointInSolid(refs.world, px, py);
		if (solid !== undefined && !(solid.kind === "door" && solid.open)) {
			hx = px;
			hy = py;
			break;
		}
		let hitZombie = false;
		for (const z of refs.zombies) {
			if (z.hp <= 0) continue;
			if (math.abs(z.x - px) < HIT_RADIUS && math.abs(z.y - py) < HIT_RADIUS) {
				damageZombie(refs, z, damage, angle);
				refs.particles.bloodBurst(z.x, z.y, 4);
				hx = px;
				hy = py;
				hitZombie = true;
				break;
			}
		}
		if (hitZombie) break;
	}
	addTracer(refs, x0, y0, hx, hy, color);
}

function meleeSwing(refs: GameRefs, w: WeaponDef, aim: number): void {
	const p = refs.player;
	const isChainsaw = w.id === 5;
	const reach = (isChainsaw ? 44 : math.max(w.range, 20) + 18) * 1.4;
	const coneRad = (isChainsaw ? 100 : w.cone) * DEG * 0.5;
	const meleeBonus = 1 + refs.save.skillLevels[3] * 0.25;
	for (const z of refs.zombies) {
		if (z.hp <= 0) continue;
		const d = math.sqrt((z.x - p.x) * (z.x - p.x) + (z.y - p.y) * (z.y - p.y));
		if (d > reach) continue;
		const toZ = math.atan2(z.y - p.y, z.x - p.x);
		if (math.abs(angleDiff(aim, toZ)) > coneRad) continue;
		damageZombie(refs, z, math.floor(damageCal(w.dmg) * meleeBonus), aim);
		applyKnockback(z, toZ, refs.save.skillLevels[2] > 0 ? 9 : 5);
		refs.particles.bloodBurst(z.x, z.y, 3);
	}
	addTracer(refs, p.x, p.y, p.x + math.cos(aim) * reach, p.y + math.sin(aim) * reach, COLORS.item);
	p.swingerActive = true;
	p.swingerAngle = aim;
}

/**
 * Equip another weapon mid-run. Called by main.client (backpack); combat owns the rules
 * (return loaded rounds to the pool, reset reload/bow/recoil state).
 */
export function switchWeapon(refs: GameRefs, weaponId: number): void {
	const w = WEAPONS[weaponId];
	if (w === undefined) return;
	refs.save.equipWeapon = weaponId;
	refs.player.weapon.pointer = weaponId;
	refs.player.weapon.ammoCount = w.mag;
}

export class Combat {
	private fireCd = 0;

	private startReload(refs: GameRefs, w: WeaponDef): void {
		const rt = refs.player.weapon;
		if (rt.reloading) return;
		if (w.mag <= 0) return;
		if (rt.ammoCount >= w.mag) return;
		if (w.kind !== WeaponKind.Special && poolGet(refs, w.ammoPool) <= 0) return;
		rt.reloading = true;
		rt.reloadCount = w.reload * (1 + refs.save.skillLevels[4] / 4);
		rt.relaunchCount = 0;
	}

	private finishReload(refs: GameRefs, w: WeaponDef): void {
		const rt = refs.player.weapon;
		const isShell = w.kind === WeaponKind.Shotgun;
		const want = isShell ? 1 : w.mag - rt.ammoCount;
		const take = math.max(0, math.min(want, poolGet(refs, w.ammoPool)));
		rt.ammoCount += take;
		poolSpend(refs, w.ammoPool, take);
		if (isShell && rt.ammoCount < w.mag && poolGet(refs, w.ammoPool) > 0) {
			rt.reloadCount = w.reload * (1 + refs.save.skillLevels[4] / 4);
			rt.relaunchCount = 0;
		} else {
			rt.reloading = false;
		}
	}

	private fireGun(refs: GameRefs, w: WeaponDef, aim: number): void {
		const p = refs.player;
		const rt = p.weapon;
		if (w.kind === WeaponKind.Special) {
			if (!spendSpecial(refs, w)) return;
		} else {
			if (rt.ammoCount <= 0) {
				this.startReload(refs, w);
				return;
			}
			rt.ammoCount--;
		}
		const skillSpread = refs.save.skillLevels[5] > 0 ? 0.6 : 1;
		const spread = (w.cone + rt.angleRange) * DEG * skillSpread;
		const color = w.kind === WeaponKind.Special ? (w.id === 25 ? COLORS.campfire : COLORS.uiBlue) : COLORS.bullet;
		for (let i = 0; i < w.pellets; i++) {
			const a = aim + (math.random() * 2 - 1) * spread * 0.5;
			resolveHitscan(refs, p.x, p.y, a, w.range, damageCal(w.dmg), color);
		}
		rt.angleRange = math.min(40, rt.angleRange + w.recoil);
		rt.autoReloadIdle = 0;
		this.fireCd = w.cooldown;
	}

	private fireArrow(refs: GameRefs, w: WeaponDef, aim: number, power: number): void {
		const p = refs.player;
		const rt = p.weapon;
		if (poolGet(refs, w.ammoPool) <= 0) return;
		poolSpend(refs, w.ammoPool, 1);
		const skillSpread = refs.save.skillLevels[6] > 0 ? 0.5 : 1;
		const a = aim + (math.random() * 2 - 1) * w.cone * DEG * skillSpread;
		const dmg = math.floor(damageCal(w.dmg) * (0.5 + 0.5 * power));
		const bullet: Bullet = {
			id: -(500000 + refs.bullets.size()),
			x: p.x,
			y: p.y,
			angle: a,
			range: w.range,
			travel: 0,
			damage: dmg,
			speed: 600,
			kind: "arrow",
			alive: true,
			fromPlayer: true,
			alpha: 1,
			life: 3,
		};
		refs.bullets.push(bullet);
		rt.autoReloadIdle = 0;
		rt.bowCount = 0;
		this.fireCd = w.cooldown;
	}

	private fireSniper(refs: GameRefs, w: WeaponDef, aim: number): void {
		const p = refs.player;
		const rt = p.weapon;
		if (rt.ammoCount <= 0) {
			this.startReload(refs, w);
			return;
		}
		rt.ammoCount--;
		const spread = w.cone * DEG * 0.3;
		const a = aim + (math.random() * 2 - 1) * spread;
		resolveHitscan(refs, p.x, p.y, a, w.range, damageCal(w.dmg), COLORS.bullet);
		rt.angleRange = math.min(40, rt.angleRange + w.recoil);
		rt.autoReloadIdle = 0;
		this.fireCd = w.cooldown;
	}

	private updateBullets(refs: GameRefs, dt: number): void {
		const p = refs.player;
		for (let i = refs.bullets.size() - 1; i >= 0; i--) {
			const b = refs.bullets[i];
			if (!b.alive) {
				refs.bullets.remove(i);
				continue;
			}
			const step = b.speed * dt;
			const nx = b.x + math.cos(b.angle) * step;
			const ny = b.y + math.sin(b.angle) * step;
			b.travel += step;
			b.life -= dt;
			let dead = false;
			if (!b.fromPlayer) {
				const pd = math.sqrt((nx - p.x) * (nx - p.x) + (ny - p.y) * (ny - p.y));
				if (pd < 24) {
					damageToPlayer(p, refs.save, b.damage);
					p.reactionDir = b.angle + math.pi;
					dead = true;
				}
			} else {
				for (const z of refs.zombies) {
					if (z.hp <= 0) continue;
					if (math.abs(z.x - nx) < HIT_RADIUS && math.abs(z.y - ny) < HIT_RADIUS) {
						damageZombie(refs, z, b.damage, b.angle);
						refs.particles.bloodBurst(z.x, z.y, 3);
						dead = true;
						break;
					}
				}
			}
			if (!dead) {
				const solid = pointInSolid(refs.world, nx, ny);
				if (solid !== undefined && !(solid.kind === "door" && solid.open)) {
					dead = true;
					refs.particles.debrisBurst(nx, ny, 3, COLORS.shadow);
				}
			}
			b.x = nx;
			b.y = ny;
			if (dead || b.travel >= b.range || b.life <= 0) {
				b.alive = false;
				refs.bullets.remove(i);
			}
		}
	}

	private decayTracers(refs: GameRefs, dt: number): void {
		for (let i = refs.tracers.size() - 1; i >= 0; i--) {
			refs.tracers[i].life -= dt;
			if (refs.tracers[i].life <= 0) refs.tracers.remove(i);
		}
	}

	update(refs: GameRefs, dt: number): void {
		const p = refs.player;
		const input = refs.input;
		this.decayTracers(refs, dt);
		if (refs.pendingPlace >= 0) {
			this.updateBullets(refs, dt);
			return;
		}
		if (p.swingerActive && this.fireCd <= 0) {
			p.swingerActive = false;
		}
		if (this.fireCd > 0) this.fireCd -= dt;
		const w = currentWeapon(p);
		const rt = p.weapon;
		const aim = p.angle;

		if (rt.reloading) {
			rt.reloadCount -= dt;
			if (rt.reloadCount <= 0) {
				this.finishReload(refs, w);
			}
		} else if (input.reloadPressed) {
			this.startReload(refs, w);
		} else if (w.kind !== WeaponKind.Melee && w.kind !== WeaponKind.Bow && w.mag > 0) {
			if (rt.ammoCount < w.mag && poolGet(refs, w.ammoPool) > 0) {
				rt.autoReloadIdle += dt;
				if (rt.autoReloadIdle >= 1) {
					this.startReload(refs, w);
				}
			}
		}

		if (w.kind === WeaponKind.Melee) {
			const want = w.auto ? input.attackHeld : input.attackPressed;
			if (want && this.fireCd <= 0) {
				const canFire = w.id !== 5 || refs.save.oil > 0;
				if (canFire) {
					if (w.id === 5) refs.save.oil = math.max(0, refs.save.oil - 1);
					meleeSwing(refs, w, aim);
					this.fireCd = w.cooldown;
				}
			}
		} else if (w.kind === WeaponKind.Bow) {
			if (input.attackHeld) {
				rt.bowCount = math.min(1, rt.bowCount + dt * 2);
			}
			if (input.attackReleased && rt.bowCount > 0.1 && this.fireCd <= 0) {
				this.fireArrow(refs, w, aim, rt.bowCount);
			}
			if (!input.attackHeld) {
				rt.bowCount = math.max(0, rt.bowCount - dt);
			}
		} else if (w.kind === WeaponKind.Sniper) {
			if (input.attackHeld) {
				rt.scopeTime += dt;
			}
			if (input.attackReleased && this.fireCd <= 0) {
				this.fireSniper(refs, w, aim);
				rt.scopeTime = 0;
			}
		} else if (w.kind === WeaponKind.Special) {
			if (this.fireCd <= 0 && input.attackHeld) {
				this.fireGun(refs, w, aim);
			}
		} else {
			const want = w.auto ? input.attackHeld : input.attackPressed;
			if (want && this.fireCd <= 0) {
				this.fireGun(refs, w, aim);
			}
		}

		rt.angleRange = math.max(0, rt.angleRange - 25 * dt);
		this.updateBullets(refs, dt);
	}
}
