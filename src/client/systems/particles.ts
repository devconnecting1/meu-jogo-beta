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

/**
 * Blood, sparks and splats. Nothing here is an Instance (the loop draws them through the renderer's pool), and from
 * the second fight on nothing here is a new table either (M4): a spent particle goes to a free list and the next
 * spray takes it back, and a decal that the ring buffer overwrites is rewritten in place. A hit sprayed about 10
 * records and left about 5 more as it landed -- hundreds of tables a second in a fight, for the collector.
 */
export class ParticleSystem {
	/** the low quality tier (client/gameLoop.ts sets it each frame): the smaller budgets for what is born from now on */
	lowDetail = false;
	private pool: Array<Particle> = [];
	/** spent particles, taken back by the next spray */
	private free: Array<Particle> = [];
	/** ring buffer: when full the oldest decal is overwritten */
	private decals: Array<Decal> = [];
	/** decals of a cleared ring, taken back by the next ones */
	private freeDecals: Array<Decal> = [];
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
			// the rolls in the order the literal made them (x, y, size, then the decal's): same sprays, same seed
			const p = this.take();
			p.x = x + rndRange(-6, 6);
			p.y = y + rndRange(-6, 6);
			p.vx = math.cos(a) * s;
			p.vy = math.sin(a) * s;
			p.life = life;
			p.maxLife = life;
			p.size = rndRange(4, 8);
			p.color = color;
			p.drag = 7;
			p.decal = math.random() < 0.55;
			this.spawn(p);
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
			const p = this.take();
			p.x = x;
			p.y = y;
			p.vx = math.cos(a) * s;
			p.vy = math.sin(a) * s;
			p.life = life;
			p.maxLife = life;
			p.size = rndRange(3, 7);
			p.color = color;
			p.drag = 5;
			p.decal = false;
			this.spawn(p);
		}
	}

	/** Add a ground splat directly (e.g. acid, oil). */
	addDecal(x: number, y: number, size: number, color: Color3): void {
		let d: Decal | undefined;
		// a ring over the first `cap` slots; after a drop to the low tier the slots past it just run out their life
		const cap = this.lowDetail ? LOW_DECALS : MAX_DECALS;
		if (this.decals.size() < cap) {
			d = this.freeDecals.pop();
			if (d === undefined) d = { x, y, size, color, life: DECAL_LIFE, maxLife: DECAL_LIFE };
			this.decals.push(d);
		} else {
			// the oldest splat gives its record to the newest
			if (this.decalNext >= cap) this.decalNext = 0;
			d = this.decals[this.decalNext];
			this.decalNext = (this.decalNext + 1) % cap;
		}
		d.x = x;
		d.y = y;
		d.size = size;
		d.color = color;
		d.life = DECAL_LIFE;
		d.maxLife = DECAL_LIFE;
	}

	/** a spent record, or a new one while the pool is still growing (its fields are all written by the caller) */
	private take(): Particle {
		const p = this.free.pop();
		if (p !== undefined) return p;
		return { x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 0, color: COLORS.blood, drag: 0, decal: false };
	}

	private spawn(p: Particle): void {
		const cap = this.lowDetail ? LOW_PARTICLES : MAX_PARTICLES;
		if (this.pool.size() >= cap) {
			// drop a random live particle instead of shifting the whole array; its record goes back to the free list
			const i = math.random(0, cap - 1);
			this.free.push(this.pool[i]);
			this.pool[i] = p;
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
				this.free.push(p);
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

	/** the live particles, read in place (no closure per frame): valid until the next update or burst */
	active(): ReadonlyArray<Particle> {
		return this.pool;
	}

	/** every decal record, spent ones included: a reader skips `life <= 0` */
	decalRecords(): ReadonlyArray<Decal> {
		return this.decals;
	}

	clear(): void {
		for (const p of this.pool) this.free.push(p);
		for (const d of this.decals) this.freeDecals.push(d);
		this.pool.clear();
		this.decals.clear();
		this.decalNext = 0;
	}
}
