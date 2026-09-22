import { COLORS } from "shared/engine/colors";
import { rndRange } from "shared/engine/rng";

export interface Particle {
	x: number;
	y: number;
	vx: number;
	vy: number;
	life: number;
	maxLife: number;
	size: number;
	color: Color3;
	grav: number;
}

const MAX_PARTICLES = 400;

export class ParticleSystem {
	private pool: Array<Particle> = [];

	bloodBurst(x: number, y: number, count: number): void {
		for (let i = 0; i < count; i++) {
			this.spawn({
				x: x + rndRange(-8, 8),
				y: y + rndRange(-8, 8),
				vx: rndRange(-90, 90),
				vy: rndRange(-140, -40),
				life: rndRange(0.35, 0.7),
				maxLife: 0.7,
				size: rndRange(3, 7),
				color: COLORS.blood,
				grav: 320,
			});
		}
	}

	debrisBurst(x: number, y: number, count: number, color: Color3): void {
		for (let i = 0; i < count; i++) {
			const a = rndRange(0, math.pi * 2);
			const s = rndRange(40, 160);
			this.spawn({
				x,
				y,
				vx: math.cos(a) * s,
				vy: math.sin(a) * s - 60,
				life: rndRange(0.4, 0.9),
				maxLife: 0.9,
				size: rndRange(3, 8),
				color,
				grav: 300,
			});
		}
	}

	private spawn(p: Particle): void {
		if (this.pool.size() >= MAX_PARTICLES) {
			this.pool.remove(0);
		}
		this.pool.push(p);
	}

	update(dt: number): void {
		for (let i = this.pool.size() - 1; i >= 0; i--) {
			const p = this.pool[i];
			p.life -= dt;
			if (p.life <= 0) {
				this.pool.remove(i);
				continue;
			}
			p.vy += p.grav * dt;
			p.x += p.vx * dt;
			p.y += p.vy * dt;
		}
	}

	forActive(cb: (p: Particle) => void): void {
		for (const p of this.pool) {
			cb(p);
		}
	}

	clear(): void {
		this.pool.clear();
	}
}
