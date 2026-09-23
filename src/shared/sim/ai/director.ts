/*
 * Pacing director (docs/DESIGN_RULES.md P2, MP-09).
 *
 * The original's "director" is a lookup table: day < 2 → 5 ambient zombies and waves of 3/3/6, day < 4 → 8
 * and 5/5/10, and so on (sys_spawn_time_light). It never looks at the player. A survivor who is winning gets
 * the same trickle as one who is bleeding out, and pressure never lets go, so the night is a flat line.
 *
 * This is the Left 4 Dead idea, kept small: measure how rough the last few seconds were (damage taken, kills,
 * how many zombies are breathing down the survivors' necks, how low their health is), and when the intensity
 * peaks, FORCE a quiet stretch before letting it build again. Peak → relief → build → peak.
 *
 * It ADJUSTS the original's balance instead of replacing it:
 *   - it scales the AMBIENT quota and the spawn intervals, inside [MIN_SCALE, MAX_SCALE];
 *   - the 19h / 22h / 1h wave QUEUES are never touched — a relief only paces a wave (down to WAVE_MIN of its
 *     rate), so the night still delivers every zombie the original promised;
 *   - the caller still enforces MP-09 (150 alive, nothing spawning within 720 u of a survivor).
 *
 * Pure: a sample in, two multipliers out. No world, no Instances, no random (§11.2).
 */

/** what the director measures each update */
export interface DirectorSample {
	/** hp the survivors lost since the last update */
	damage: number;
	/** zombies killed since the last update */
	kills: number;
	/** zombies within DIRECTOR_NEAR of a survivor right now */
	near: number;
	/** 0…1: average health of the living survivors */
	health: number;
}

export type DirectorPhase =
	/** pressure is allowed to grow */
	| "build"
	/** the fight is at its height: stop feeding it, let them fight what is already there */
	| "peak"
	/** the mandatory quiet stretch */
	| "relax"
	/** coming back up to normal */
	| "calm";

/** zombies this close to a survivor count as "on top of them" */
export const DIRECTOR_NEAR = 500;

/** intensity per hp of damage taken (a full 100 hp fight is a whole peak on its own) */
export const I_DAMAGE = 0.01;
/** intensity per kill (fighting is intense even when you are winning) */
export const I_KILL = 0.012;
/** intensity per second per zombie inside DIRECTOR_NEAR */
export const I_CROWD = 0.01;
/** intensity per second at 0 hp, scaled by how hurt they are */
export const I_HURT = 0.05;
/** intensity lost per second when nothing is happening */
export const I_DECAY = 0.085;

/** intensity that triggers a peak */
export const PEAK_IN = 0.8;
/** a peak never lasts longer than this */
export const PEAK_MAX = 14;
/** …and ends early once the fight has clearly calmed */
export const PEAK_OUT = 0.55;
/** the relief lasts at least this long, whatever the survivors do */
export const RELAX_MIN = 25;
/** …and at most this long, so the game never stalls */
export const RELAX_MAX = 45;
/** the relief ends when intensity is back under this (and RELAX_MIN has passed) */
export const RELAX_OUT = 0.25;
/** seconds the pressure takes to climb back to normal after a relief */
export const CALM_RAMP = 12;

/** spawn multiplier floor (during the relief) and ceiling (a long quiet build-up) */
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 1.6;
/** the multiplier during a peak: the horde on screen is the pressure, no need to add more */
export const PEAK_SCALE = 0.6;
/** however quiet the director wants it, a night wave never trickles slower than this fraction of its rate */
export const WAVE_MIN = 0.5;
export const WAVE_MAX = 1.25;
/** how fast the ambient multiplier climbs while building */
export const BUILD_RATE = 0.06;

/**
 * Peak → relief → build → peak. One instance per world (the Spawner owns it); in F2 it lives in
 * server/sim/population.ts, one per cluster.
 */
export class PaceDirector {
	/** 0…1: how rough the last few seconds were */
	intensity = 0;
	phase: DirectorPhase = "build";
	/** seconds spent in the current phase */
	phaseTime = 0;
	/** multiplier for the ambient quota and the ambient spawn interval */
	ambientScale = 1;
	/** multiplier for the night-wave trickle rate only — the queues themselves are never touched */
	waveScale = 1;
	/** seconds of relief granted so far (diagnostics and tools/test-ai.mjs) */
	reliefTime = 0;
	/** peaks resolved so far */
	peaks = 0;

	private enter(phase: DirectorPhase): void {
		this.phase = phase;
		this.phaseTime = 0;
	}

	update(s: DirectorSample, dt: number): void {
		if (dt <= 0) return;
		let i = this.intensity;
		i += s.damage * I_DAMAGE;
		i += s.kills * I_KILL;
		i += s.near * I_CROWD * dt;
		i += (1 - math.clamp(s.health, 0, 1)) * I_HURT * dt;
		i -= I_DECAY * dt;
		this.intensity = math.clamp(i, 0, 1);
		this.phaseTime += dt;

		if (this.phase === "build") {
			this.ambientScale = math.min(MAX_SCALE, this.ambientScale + BUILD_RATE * dt);
			if (this.intensity >= PEAK_IN) {
				this.peaks += 1;
				this.enter("peak");
			}
		} else if (this.phase === "peak") {
			this.ambientScale = PEAK_SCALE;
			if (this.phaseTime >= PEAK_MAX || this.intensity <= PEAK_OUT) this.enter("relax");
		} else if (this.phase === "relax") {
			this.ambientScale = MIN_SCALE;
			this.reliefTime += dt;
			if (this.phaseTime >= RELAX_MAX || (this.phaseTime >= RELAX_MIN && this.intensity <= RELAX_OUT)) {
				this.enter("calm");
			}
		} else {
			this.reliefTime += dt;
			const t = math.clamp(this.phaseTime / CALM_RAMP, 0, 1);
			this.ambientScale = MIN_SCALE + (1 - MIN_SCALE) * t;
			// a peak during the ramp is real pressure the survivors asked for: let it through
			if (this.intensity >= PEAK_IN) {
				this.peaks += 1;
				this.enter("peak");
			} else if (t >= 1) {
				this.enter("build");
			}
		}
		this.ambientScale = math.clamp(this.ambientScale, MIN_SCALE, MAX_SCALE);
		this.waveScale = math.clamp(this.ambientScale, WAVE_MIN, WAVE_MAX);
	}

	/** is the world in its mandatory quiet stretch right now? */
	relieving(): boolean {
		return this.phase === "relax" || this.phase === "calm";
	}
}
