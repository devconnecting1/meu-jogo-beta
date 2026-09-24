/*
 * Music, ambience and stingers.
 *
 * Shape of the soundtrack (the original's rule, kept and tightened):
 *  - DAY: no music at all. Only a light ambience bed — a small American town a few days into the outbreak:
 *    birds, air, no traffic (DESIGN_RULES §1). Right after dawn an extra bird layer fades in and out.
 *  - NIGHT: the ambience bed crossfades into the night music when the clock passes 19:00 and back at 06:00.
 *    The crossfade is short (2.5 s in, 3.5 s out) so the change of mood lands with the light change.
 *  - STINGERS: one hit when each wave is announced (19h / 22h / 1h, lower and heavier every time) and one
 *    at dawn. They ride the BGM bus and are capped well below the music, so nothing ever jumps out.
 *  - HEARTBEAT: below 35% HP, in three levels like the original (35% / 22% / 10%), crossfading between
 *    them. It stops as soon as the survivor heals back over the threshold, and while dead.
 */
import { audio, AudioTrack } from "./audio";

/** HP ratio at which each heartbeat level starts */
const HEART_L1 = 0.35;
const HEART_L2 = 0.22;
const HEART_L3 = 0.1;
/** how far above its threshold the HP has to climb before a heartbeat level is left */
export const HEART_HYSTERESIS = 0.03;

/** dawn bird layer: full between these hours, faded at the edges */
const DAWN_FROM = 6;
const DAWN_PEAK = 7.5;
const DAWN_TO = 10;

export interface MusicState {
	isNight: boolean;
	dayTime: number;
	/** hp / hpMax of the local survivor */
	hpRatio: number;
	dead: boolean;
}

/** 0..1 ramp of the dawn bird layer at this hour */
function dawnLevel(dayTime: number): number {
	if (dayTime <= DAWN_FROM || dayTime >= DAWN_TO) return 0;
	if (dayTime < DAWN_PEAK) return (dayTime - DAWN_FROM) / (DAWN_PEAK - DAWN_FROM);
	return 1 - (dayTime - DAWN_PEAK) / (DAWN_TO - DAWN_PEAK);
}

export class GameMusic {
	/** night music <-> day ambience; one channel, so the two never play at full volume together */
	private bed: AudioTrack;
	private dawn: AudioTrack;
	private heart: AudioTrack;
	private heartLevel = 0;

	constructor() {
		this.bed = audio.createTrack("bgm", 2.5, 3.5);
		this.dawn = audio.createTrack("bgm", 4, 4);
		this.heart = audio.createTrack("bgm", 1.2, 1.5);
	}

	/** called every frame of a live run */
	update(s: MusicState): void {
		this.bed.set(s.isNight ? "bgmNight" : "ambDay");
		// dead: the world keeps breathing, but quietly (nothing is "playing" any more)
		this.bed.setLevel(s.dead ? 0.35 : 1);

		const dawn = s.dead ? 0 : dawnLevel(s.dayTime);
		if (dawn > 0.01) {
			this.dawn.set("ambDawn");
			this.dawn.setLevel(dawn);
		} else {
			this.dawn.stop();
		}

		this.updateHeartbeat(s);
	}

	/**
	 * A level is entered under its threshold and left only HEART_HYSTERESIS above it: the HP of a survivor regenerating
	 * against a drain, or the server's HP interpolated between snapshots, wanders across 35 % for seconds, and every
	 * crossing used to swap the heartbeat's clip.
	 */
	private updateHeartbeat(s: MusicState): void {
		let level = 0;
		if (!s.dead && s.hpRatio > 0) {
			if (this.under(s.hpRatio, HEART_L3, 3)) level = 3;
			else if (this.under(s.hpRatio, HEART_L2, 2)) level = 2;
			else if (this.under(s.hpRatio, HEART_L1, 1)) level = 1;
		}
		if (level === this.heartLevel) return;
		this.heartLevel = level;
		if (level === 0) this.heart.stop();
		else this.heart.set(level === 1 ? "heartbeat1" : level === 2 ? "heartbeat2" : "heartbeat3");
	}

	/** is `hp` inside heartbeat level `lvl` (under `threshold`, or under it + the hysteresis while already in it)? */
	private under(hp: number, threshold: number, lvl: number): boolean {
		return hp < threshold + (this.heartLevel >= lvl ? HEART_HYSTERESIS : 0);
	}

	/** wave 1, 2 or 3 was announced */
	waveStinger(wave: number): void {
		if (wave === 1) audio.play("stingerWave1");
		else if (wave === 2) audio.play("stingerWave2");
		else audio.play("stingerWave3");
	}

	/** the clock passed 7:00 and the survivor is still alive */
	dawnStinger(): void {
		audio.play("stingerDawn");
	}

	/** back to the menus: nothing from the run keeps playing behind the UI */
	stop(): void {
		this.bed.stop();
		this.dawn.stop();
		this.heart.stop();
		this.heartLevel = 0;
	}
}
