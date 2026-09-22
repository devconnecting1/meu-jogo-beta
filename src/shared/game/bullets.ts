import { damageCal } from "shared/engine/rng";
import { WeaponDef } from "shared/data/weapons";

export interface Bullet {
	id: number;
	x: number;
	y: number;
	angle: number;
	range: number;
	travel: number;
	damage: number;
	speed: number;
	kind: "hitscan" | "arrow" | "fire" | "electric";
	alive: boolean;
	fromPlayer: boolean;
	alpha: number;
	// hitscan resolved
	hitX?: number;
	hitY?: number;
	life: number;
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
