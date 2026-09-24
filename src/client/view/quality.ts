/*
 * The client's quality tier (docs/research/performance.md §8.4, DESIGN_RULES UI-07 "Graphics"): High or Low, by the
 * player's Graphics setting (Settings › General: Auto, High, Low -- SettingsData.graphics) and, in Auto, by the frame
 * time this client measures. The engine's own quality level only scales 3D rendering (distance, shading, its particles),
 * and this game draws nothing in 3D: on a weak or thermally throttled phone nothing gives unless the game does it.
 *
 * What the tier drives -- never what reads the game (LEG-03 rims, the zombies' marks, how far a light reaches):
 *   - the night's light map (shared/engine/renderer.ts LightMap.setLowDetail): taller strips, and a cap on the
 *     gradient rewrites of a frame;
 *   - blood and debris (client/systems/particles.ts): half the particles and half the decals alive at once.
 *
 * Auto, by the frame time with hysteresis, so it never flaps:
 *   - the frames are averaged over WINDOW_S windows; a window with a hitch (one frame over HITCH_S: a load, a GC
 *     pause, the window dragged) is thrown away and changes nothing;
 *   - DROP_WINDOWS slow windows in a row (a mean over SLOW_S: under ~45 FPS) drop to Low;
 *   - on Low, RISE_WINDOWS fast windows in a row (under FAST_S: ~55 FPS and up, a 60 Hz screen at full speed) try High;
 *   - a try that turns slow again within FAIL_S failed: the next one waits twice as long, and after MAX_FAILED failed
 *     tries this session stays on Low. A phone that holds 60 FPS on Low but not on High therefore settles on Low after
 *     at most five switches, instead of swinging between the two every 23 s (tools/test-light.mjs).
 * Only a run's frames are measured (client/gameLoop.ts), and only while the setting is Auto.
 */

/** SettingsData.graphics: what the Settings row writes */
export const GRAPHICS_AUTO = 0;
export const GRAPHICS_HIGH = 1;
export const GRAPHICS_LOW = 2;
/** the row's options, in that order (lang.ts keys) */
export const GRAPHICS_OPTIONS = ["Auto", "High", "Low"];

/** one averaging window, s */
const WINDOW_S = 1;
/** a single frame this long makes its window meaningless (s) */
const HITCH_S = 0.25;
/** a window slower than this (mean frame, s) is slow; faster than FAST_S, fast; in between, neither */
const SLOW_S = 0.022;
const FAST_S = 0.018;
/** slow windows in a row that drop to Low, and fast ones in a row that try High again (doubled per failed try) */
const DROP_WINDOWS = 3;
const RISE_WINDOWS = 20;
/** a drop this soon (s) after trying High means the try failed */
const FAIL_S = 30;
/** failed tries after which the session stays on Low */
const MAX_FAILED = 2;

/** The Auto tier's state machine: fed a run's frame times, it answers High or Low. Pure (tools/test-light.mjs). */
export class QualityGovernor {
	/** the tier Auto picked */
	low = false;
	/** how many times it changed (the admin panel's stats card) */
	switches = 0;
	/** the mean frame time of the last window that counted, s (0 before the first) */
	lastWindow = 0;
	/** Low for the rest of the session: High was tried and failed MAX_FAILED times */
	locked = false;
	private winTime = 0;
	private winFrames = 0;
	private winHitch = false;
	private slow = 0;
	private fast = 0;
	private failed = 0;
	private sinceRise = math.huge;

	/** one frame that took `dt` seconds; returns whether the tier is Low */
	sample(dt: number): boolean {
		this.sinceRise += dt;
		this.winTime += dt;
		this.winFrames += 1;
		if (dt > HITCH_S) this.winHitch = true;
		if (this.winTime < WINDOW_S) return this.low;
		const mean = this.winTime / this.winFrames;
		const hitch = this.winHitch;
		this.winTime = 0;
		this.winFrames = 0;
		this.winHitch = false;
		if (hitch) return this.low;
		this.lastWindow = mean;
		if (mean > SLOW_S) {
			this.slow += 1;
			this.fast = 0;
		} else if (mean < FAST_S) {
			this.fast += 1;
			this.slow = 0;
		} else {
			this.slow = 0;
			this.fast = 0;
		}
		if (!this.low && this.slow >= DROP_WINDOWS) {
			this.low = true;
			this.switches += 1;
			this.slow = 0;
			this.fast = 0;
			if (this.sinceRise <= FAIL_S) {
				this.failed += 1;
				if (this.failed >= MAX_FAILED) this.locked = true;
			}
		} else if (this.low && !this.locked && this.fast >= RISE_WINDOWS * 2 ** this.failed) {
			this.low = false;
			this.switches += 1;
			this.slow = 0;
			this.fast = 0;
			this.sinceRise = 0;
		}
		return this.low;
	}
}

const governor = new QualityGovernor();

/** the tier of a frame drawn with the Graphics setting `setting`: true = Low */
export function lowDetail(setting: number): boolean {
	if (setting === GRAPHICS_HIGH) return false;
	if (setting === GRAPHICS_LOW) return true;
	return governor.low;
}

/** one frame of a run (client/gameLoop.ts update): measured in Auto only; returns this frame's tier (true = Low) */
export function qualityFrame(dt: number, setting: number): boolean {
	if (setting === GRAPHICS_AUTO) governor.sample(dt);
	return lowDetail(setting);
}

/** one line for the admin panel's stats card: the setting, the tier it gives and what Auto measured */
export function qualityReadout(setting: number): string {
	const name = GRAPHICS_OPTIONS[setting] ?? "Auto";
	const tier = lowDetail(setting) ? "Low" : "High";
	const ms = math.floor(governor.lastWindow * 10000 + 0.5) / 10;
	return `${name}>${tier} ${ms}ms ${governor.switches}sw${governor.locked ? " held" : ""}`;
}
