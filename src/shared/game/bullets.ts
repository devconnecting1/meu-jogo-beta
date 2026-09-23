import { damageCal } from "shared/engine/rng";
import { WeaponDef } from "shared/data/weapons";

/**
 * Projectiles in refs.bullets (hitscan guns only leave tracers).
 * - player arrows: kind "arrow", fromPlayer. They slow down, stop at their range or in a wall and
 *   lie on the ground (`grounded`) for 20 s so the player can pick them back up; an arrow that hits
 *   a zombie sticks in it (`stuckTo`) and drops when the zombie dies.
 * - flamethrower: kind "fire", fromPlayer, pierces zombies (burns every body it overlaps).
 * - enemy shots (fromPlayer = false): id > -100000 → spitter acid blob (becomes a puddle at
 *   targetX/targetY, no direct damage); id < -100000 → boss needle (damages the player).
 */
export interface Bullet {
	id: number;
	x: number;
	y: number;
	angle: number;
	range: number;
	travel: number;
	damage: number;
	/** px/s */
	speed: number;
	kind: "hitscan" | "arrow" | "fire" | "electric";
	alive: boolean;
	fromPlayer: boolean;
	alpha: number;
	// hitscan resolved
	hitX?: number;
	hitY?: number;
	/** seconds left before it disappears */
	life: number;
	/** arrow lying on the ground (speed 0), can be picked up */
	grounded?: boolean;
	/** id of the zombie an arrow is stuck in, and its offset from the zombie's centre */
	stuckTo?: number;
	stuckDX?: number;
	stuckDY?: number;
	/** seconds since launch (arrows can only be picked up after 1 s) */
	age?: number;
	/** spitter blob: predicted landing point */
	targetX?: number;
	targetY?: number;
	/** arrows: speed lost per second (original bull_speed_friction 0.2 px/frame²) */
	friction?: number;
}

let bulletId = 1;

export function resetBullets(): void {
	bulletId = 1;
}

export function makePlayerBullet(w: WeaponDef, x: number, y: number, angle: number, spreadDeg: number): Bullet {
	const a = angle + (rnd2() * 2 - 1) * spreadDeg * (math.pi / 180);
	return {
		id: bulletId++,
		x,
		y,
		angle: a,
		range: w.range,
		travel: 0,
		damage: damageCal(w.dmg),
		speed: w.kind === 6 ? 600 : 1800,
		kind:
			w.kind === 6
				? "arrow"
				: w.kind === 8 && w.id === 25
					? "fire"
					: w.kind === 8 && w.id === 26
						? "electric"
						: "hitscan",
		alive: true,
		fromPlayer: true,
		alpha: 1,
		life: w.kind === 6 ? 20 : 0.7,
	};
}

function rnd2(): number {
	return math.random();
}
