import { COLORS } from "shared/engine/colors";
import { rndRange } from "shared/engine/rng";

/** whose blood: zombies bleed green, the player bleeds red (or pass any colour) */
export type BloodSource = "zombie" | "player" | Color3;

export interface Particle {
	x: number;
	y: number;
	vx: number;
	vy: number;
	life: number;
	maxLife: number;
	size: number;
	color: Color3;
	/** exponential ground friction (1/s): top-down, so nothing "falls" — sprays slide and stop */
	drag: number;
	/** leaves a blood decal where it lands */
	decal: boolean;
}

/** flat splat left on the ground; fades out over DECAL_LIFE seconds */
export interface Decal {
	x: number;
	y: number;
	size: number;
	color: Color3;
	life: number;
	maxLife: number;
}

const MAX_PARTICLES = 320;
const MAX_DECALS = 160;
/** the low quality tier's budgets (client/view/quality.ts): half as many alive at once */
const LOW_PARTICLES = 160;
const LOW_DECALS = 80;
export const DECAL_LIFE = 10;

function bloodColor(source: BloodSource): Color3 {
	if (source === "zombie") return COLORS.bloodZombie;
	if (source === "player") return COLORS.blood;
	return source;
}

export class ParticleSystem {
	/** the low quality tier (client/gameLoop.ts sets it each frame): the smaller budgets for what is born from now on */
	lowDetail = false;
	private pool: Array<Particle> = [];
	/** ring buffer: when full the oldest decal is overwritten */
	private decals: Array<Decal> = [];
	private decalNext = 0;

	/**
	 * Radial blood spray. `dir` (radians, optional) biases the spray away from the hit — pass the
	 * bullet/swing angle. Big bursts (kills, count ≥ 8) also leave a pool under the victim.
	 */
	bloodBurst(x: number, y: number, count: number, source: BloodSource = "zombie", dir?: number): void {
		const color = bloodColor(source);
		for (let i = 0; i < count; i++) {
			const a = dir !== undefined ? dir + rndRange(-0.75, 0.75) : rndRange(0, math.pi * 2);
			const s = rndRange(70, 260);
			const life = rndRange(0.2, 0.45);
			this.spawn({
				x: x + rndRange(-6, 6),
				y: y + rndRange(-6, 6),
				vx: math.cos(a) * s,
				vy: math.sin(a) * s,
				life,
				maxLife: life,
				size: rndRange(4, 8),
				color,
				drag: 7,
				decal: math.random() < 0.55,
			});
		}
		if (count >= 8) {
			this.addDecal(x, y, rndRange(26, 40), color);
		}
	}

	/** Radial debris (wood chips, sparks, dust) with friction; leaves no decal. */
	debrisBurst(x: number, y: number, count: number, color: Color3): void {
		for (let i = 0; i < count; i++) {
			const a = rndRange(0, math.pi * 2);
			const s = rndRange(50, 220);
			const life = rndRange(0.3, 0.7);
			this.spawn({
				x,
				y,
				vx: math.cos(a) * s,
				vy: math.sin(a) * s,
				life,
				maxLife: life,
				size: rndRange(3, 7),
				color,
				drag: 5,
				decal: false,
			});
		}
	}

	/** Add a ground splat directly (e.g. acid, oil). */
	addDecal(x: number, y: number, size: number, color: Color3): void {
		const d: Decal = { x, y, size, color, life: DECAL_LIFE, maxLife: DECAL_LIFE };
		// a ring over the first `cap` slots; after a drop to the low tier the slots past it just run out their life
		const cap = this.lowDetail ? LOW_DECALS : MAX_DECALS;
		if (this.decals.size() < cap) {
			this.decals.push(d);
		} else {
			if (this.decalNext >= cap) this.decalNext = 0;
			this.decals[this.decalNext] = d;
			this.decalNext = (this.decalNext + 1) % cap;
		}
	}

	private spawn(p: Particle): void {
		const cap = this.lowDetail ? LOW_PARTICLES : MAX_PARTICLES;
		if (this.pool.size() >= cap) {
			// drop a random live particle instead of shifting the whole array
			this.pool[math.random(0, cap - 1)] = p;
			return;
		}
		this.pool.push(p);
	}

	update(dt: number): void {
		for (let i = this.pool.size() - 1; i >= 0; i--) {
			const p = this.pool[i];
			p.life -= dt;
			if (p.life <= 0) {
				if (p.decal) {
					this.addDecal(p.x, p.y, p.size * rndRange(1.2, 2), p.color);
				}
				this.pool.unorderedRemove(i);
				continue;
			}
			const f = math.exp(-p.drag * dt);
			p.vx *= f;
			p.vy *= f;
			p.x += p.vx * dt;
			p.y += p.vy * dt;
		}
		for (const d of this.decals) {
			if (d.life > 0) d.life -= dt;
		}
	}

	forActive(cb: (p: Particle) => void): void {
		for (const p of this.pool) {
			cb(p);
		}
	}

	/** live decals only */
	forDecals(cb: (d: Decal) => void): void {
		for (const d of this.decals) {
			if (d.life > 0) cb(d);
		}
	}

	clear(): void {
		this.pool.clear();
		this.decals.clear();
		this.decalNext = 0;
	}
}
