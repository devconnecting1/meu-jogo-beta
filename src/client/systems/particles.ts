import { COLORS } from "shared/engine/colors";
import { rndRange } from "shared/engine/rng";

/** whose blood: the horde bleeds a dark brownish red, the player a bright red (LEG-02), or pass any colour */
export type BloodSource = "zombie" | "player" | Color3;

/** whose a record is, for the pixel art's colours (client/view/bloodView.ts, ART-15): debris, not blood */
export const BLOOD_NONE = 0;
/** a survivor's blood */
export const BLOOD_SURVIVOR = 1;
/** the horde's */
export const BLOOD_HORDE = 2;
/** blood of a colour somebody passed in (`BloodSource` as a Color3): drawn in that colour, it never dries */
export const BLOOD_OTHER = 3;

/** a decal where a droplet landed */
export const DECAL_DROP = 0;
/** a decal where a body bled (a burst of 8 or more: a kill, a big bite) */
export const DECAL_SPLAT = 1;
/** the spatter behind a hit, thrown along its direction (pixel art only) */
export const DECAL_SMEAR = 2;

/**
 * How a stain ages in the pixel art (ART-15), in seconds from when it was shed: wet (glossy) for BLOOD_WET_S, then
 * darker and browner until it is the brown of a game day old at BLOOD_DRY_S (shared/sim/clock.ts: a game day is
 * ~605 s), then it fades away by BLOOD_LIFE_S. The flat drawing keeps its own 10 s (DECAL_LIFE).
 */
export const BLOOD_WET_S = 20;
export const BLOOD_DRY_S = 605;
export const BLOOD_LIFE_S = 905;

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
	/** BLOOD_NONE (debris), BLOOD_SURVIVOR, BLOOD_HORDE or BLOOD_OTHER */
	src: number;
	/** which of the pixel art's tones it is drawn in (0 base, 1 dark, 2 light), dealt in turn, no dice */
	tone: number;
}

/** flat splat left on the ground; fades out over DECAL_LIFE seconds (the pixel art: BLOOD_LIFE_S) */
export interface Decal {
	x: number;
	y: number;
	size: number;
	color: Color3;
	life: number;
	maxLife: number;
	/** DECAL_DROP, DECAL_SPLAT or DECAL_SMEAR */
	kind: number;
	/** whose blood (BLOOD_*) */
	src: number;
	/** a smear's direction in 45° steps (0 = +x, 2 = +y), -1 for a stain with none */
	sector: number;
	/** seconds since it was shed (or last bled on again), up to BLOOD_LIFE_S */
	age: number;
	/** what it lies on, found by the view the first time it draws it (-1: not yet) */
	ground: number;
	/** its shape among its kind's, 0..1, picked by the view from where it lies (-1: not yet) */
	pick: number;
}

const MAX_PARTICLES = 320;
const MAX_DECALS = 160;
/** the low quality tier's budgets (client/view/quality.ts): half as many alive at once */
const LOW_PARTICLES = 160;
const LOW_DECALS = 80;
export const DECAL_LIFE = 10;

/**
 * The pixel art's stains join instead of piling up (ART-15): a droplet landing this close (world units) to a stain of
 * the same blood -- a drop, a splat, a smear's bead -- bleeds on it (it is wet again) instead of taking a record; so
 * does a splat on a splat and a smear on a smear thrown the same way. A long fight on one spot is one stain, not the
 * whole ring.
 */
const JOIN_DROP = 8;
const JOIN_SPLAT = 18;
const JOIN_SMEAR = 12;

const EIGHTH = math.pi / 4;

function bloodColor(source: BloodSource): Color3 {
	if (source === "zombie") return COLORS.bloodHorde;
	if (source === "player") return COLORS.blood;
	return source;
}

function bloodSrc(source: BloodSource): number {
	if (source === "zombie") return BLOOD_HORDE;
	if (source === "player") return BLOOD_SURVIVOR;
	return BLOOD_OTHER;
}

/** a direction in 45° steps, 0..7 (0 = +x, 2 = +y: screen down) */
export function sectorOf(dir: number): number {
	const s = math.floor(dir / EIGHTH + 0.5) % 8;
	return s < 0 ? s + 8 : s;
}

/**
 * Blood, sparks and splats. Nothing here is an Instance (the loop draws them through the renderer's pool), and from
 * the second fight on nothing here is a new table either (M4): a spent particle goes to a free list and the next
 * spray takes it back, and a decal that the ring buffer overwrites is rewritten in place. A hit sprayed about 10
 * records and left about 5 more as it landed -- hundreds of tables a second in a fight, for the collector.
 *
 * With the blood's pixel art live (`pixelArt`, ART-15) the dice are thrown exactly as without it -- the same sprays --
 * and only the stains differ: they live a game day and more, a drop joins the stain it lands on, a hit with a
 * direction also leaves a smear, and a full ring gives the record of the stain shed longest ago to the new one.
 */
export class ParticleSystem {
	/** the low quality tier (client/gameLoop.ts sets it each frame): the smaller budgets for what is born from now on */
	lowDetail = false;
	/** the blood's pixel art is live (client/gameLoop.ts sets it each frame from client/view/bloodView.ts) */
	pixelArt = false;
	private pool: Array<Particle> = [];
	/** spent particles, taken back by the next spray */
	private free: Array<Particle> = [];
	/** ring buffer: when full the oldest decal is overwritten */
	private decals: Array<Decal> = [];
	/** decals of a cleared ring, taken back by the next ones */
	private freeDecals: Array<Decal> = [];
	private decalNext = 0;
	/** the next tone dealt (0 base, 1 dark, 0 base, 2 light, ...) */
	private toneNext = 0;

	/**
	 * Radial blood spray. `dir` (radians, optional) biases the spray away from the hit — pass the
	 * bullet/swing angle. Big bursts (kills, count ≥ 8) also leave a pool under the victim.
	 */
	bloodBurst(x: number, y: number, count: number, source: BloodSource = "zombie", dir?: number): void {
		const color = bloodColor(source);
		const src = bloodSrc(source);
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
			p.src = src;
			p.tone = this.nextTone();
			this.spawn(p);
		}
		if (count >= 8) {
			this.addDecal(x, y, rndRange(26, 40), color, DECAL_SPLAT, src);
		}
		// the spatter behind the hit, from the attacker through the target (no roll: the dice stay the flat drawing's)
		if (this.pixelArt && dir !== undefined) this.addDecal(x, y, 24, color, DECAL_SMEAR, src, dir);
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
			p.src = BLOOD_NONE;
			p.tone = this.nextTone();
			this.spawn(p);
		}
	}

	/**
	 * Add a ground splat directly (e.g. acid, oil). `kind`, `src` and `dir` only matter to the pixel art: what the
	 * stain is, whose blood, and which way a smear was thrown.
	 */
	addDecal(
		x: number,
		y: number,
		size: number,
		color: Color3,
		kind = DECAL_DROP,
		src = BLOOD_NONE,
		dir?: number,
	): void {
		const sector = dir !== undefined ? sectorOf(dir) : -1;
		let d: Decal | undefined;
		// a ring over the first `cap` slots; after a drop to the low tier the slots past it just run out their life
		const cap = this.lowDetail ? LOW_DECALS : MAX_DECALS;
		if (this.pixelArt) {
			const on = this.stainUnder(x, y, kind, src, sector, cap);
			if (on !== undefined) {
				// fresh blood on an old stain: it is wet again, and nothing new is drawn
				on.age = 0;
				on.life = DECAL_LIFE;
				on.maxLife = DECAL_LIFE;
				return;
			}
		}
		if (this.decals.size() < cap) {
			d = this.freeDecals.pop();
			if (d === undefined) {
				d = {
					x,
					y,
					size,
					color,
					life: DECAL_LIFE,
					maxLife: DECAL_LIFE,
					kind,
					src,
					sector,
					age: 0,
					ground: -1,
					pick: -1,
				};
			}
			this.decals.push(d);
		} else if (this.pixelArt) {
			// the stain shed longest ago gives its record to the newest (a spent one has the largest age of all)
			let at = 0;
			let oldest = -1;
			for (let i = 0; i < cap; i++) {
				const age = this.decals[i].age;
				if (age > oldest) {
					oldest = age;
					at = i;
				}
			}
			d = this.decals[at];
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
		d.kind = kind;
		d.src = src;
		d.sector = sector;
		d.age = 0;
		d.ground = -1;
		d.pick = -1;
	}

	/**
	 * The live stain of the same blood a new one at (x, y) joins (pixel art only), if any: among the ring's first `cap`
	 * records only -- one past a lowered cap is running out (`update`), and a join must not bring it back.
	 */
	private stainUnder(
		x: number,
		y: number,
		kind: number,
		src: number,
		sector: number,
		cap: number,
	): Decal | undefined {
		const n = math.min(cap, this.decals.size());
		for (let i = 0; i < n; i++) {
			const d = this.decals[i];
			if (d.src !== src || d.age >= BLOOD_LIFE_S) continue;
			let reach: number;
			if (kind === DECAL_DROP) {
				reach = d.kind === DECAL_SPLAT ? JOIN_SPLAT : d.kind === DECAL_SMEAR ? JOIN_SMEAR : JOIN_DROP;
			} else if (kind === DECAL_SPLAT) {
				if (d.kind !== DECAL_SPLAT) continue;
				reach = JOIN_SPLAT;
			} else {
				if (d.kind !== DECAL_SMEAR || d.sector !== sector) continue;
				reach = JOIN_SMEAR;
			}
			const dx = d.x - x;
			const dy = d.y - y;
			if (dx * dx + dy * dy < reach * reach) return d;
		}
		return undefined;
	}

	/** 0, 1, 0, 2, ...: mostly the base tone, a dark one and now and then a light one */
	private nextTone(): number {
		const k = this.toneNext;
		this.toneNext = (k + 1) % 4;
		return k === 1 ? 1 : k === 3 ? 2 : 0;
	}

	/** a spent record, or a new one while the pool is still growing (its fields are all written by the caller) */
	private take(): Particle {
		const p = this.free.pop();
		if (p !== undefined) return p;
		return {
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			life: 0,
			maxLife: 0,
			size: 0,
			color: COLORS.blood,
			drag: 0,
			decal: false,
			src: BLOOD_NONE,
			tone: 0,
		};
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
					this.addDecal(p.x, p.y, p.size * rndRange(1.2, 2), p.color, DECAL_DROP, p.src);
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
			if (d.age < BLOOD_LIFE_S) d.age += dt;
		}
		// after a drop to the low tier the ring is shorter: a flat splat past it runs out its 10 s, and a pixel-art
		// stain past it goes straight to its fade (dry to gone, 300 s), so the Low budget holds within minutes, not in
		// the day and a half a stain lives (and a join never picks one of these back up: `stainUnder`)
		const cap = this.lowDetail ? LOW_DECALS : MAX_DECALS;
		for (let i = cap; i < this.decals.size(); i++) {
			const d = this.decals[i];
			if (d.age < BLOOD_DRY_S) d.age = BLOOD_DRY_S;
		}
	}

	/** the live particles, read in place (no closure per frame): valid until the next update or burst */
	active(): ReadonlyArray<Particle> {
		return this.pool;
	}

	/** every decal record, spent ones included: a reader skips `life <= 0` (flat) or `age >= BLOOD_LIFE_S` (art) */
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
